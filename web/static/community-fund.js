/* Pure SputnikDAO Community Fund helpers. No keys, RPC access, or signing authority lives here. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.HarvestPoolCommunityFund = factory();
  }
}(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const YOCTO_PER_NEAR = 10n ** 24n;
  const DESCRIPTION_PREFIX = "HARVESTPOOL_COMMUNITY_FUND_V1:";
  const ALLOWED_PROPOSAL_LABELS = new Set(["transfer", "factory_info_update"]);
  const VOTE_ACTIONS = new Set(["VoteApprove", "VoteReject", "VoteRemove", "Finalize"]);

  function decimalToYocto(value) {
    const normalized = String(value ?? "").trim();
    if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
    const [whole, fraction = ""] = normalized.split(".");
    if (fraction.length > 24) return null;
    const result = BigInt(whole) * YOCTO_PER_NEAR + BigInt(fraction.padEnd(24, "0") || "0");
    return result > 0n ? result.toString() : null;
  }

  function formatNear(value, maximumFractionDigits = 4) {
    try {
      const amount = BigInt(String(value ?? "0"));
      const whole = amount / YOCTO_PER_NEAR;
      const fraction = (amount % YOCTO_PER_NEAR).toString().padStart(24, "0")
        .slice(0, Math.max(0, maximumFractionDigits)).replace(/0+$/, "");
      return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
    } catch (_error) {
      return "—";
    }
  }

  function roleAccounts(role) {
    const group = role?.kind?.Group;
    return Array.isArray(group) ? group.map(String) : [];
  }

  function permissionParts(permission) {
    const [proposal = "", action = ""] = String(permission || "").split(":", 2);
    return { proposal, action };
  }

  function grants(role, proposalLabel, action) {
    return (role?.permissions || []).some((permission) => {
      const parts = permissionParts(permission);
      return (parts.proposal === proposalLabel || parts.proposal === "*")
        && (parts.action === action || parts.action === "*");
    });
  }

  function thresholdFor(policy, role, proposalLabel = "transfer") {
    const votePolicy = role?.vote_policy?.[proposalLabel] || policy?.default_vote_policy || {};
    const memberCount = roleAccounts(role).length;
    const threshold = votePolicy.threshold;
    let required = 0;
    if (Array.isArray(threshold) && threshold.length === 2) {
      const numerator = Number(threshold[0]);
      const denominator = Number(threshold[1]);
      if (Number.isSafeInteger(numerator) && Number.isSafeInteger(denominator) && denominator > 0) {
        required = Math.min(memberCount, Math.floor((numerator * memberCount) / denominator) + 1);
      }
    } else if (/^\d+$/.test(String(threshold ?? ""))) {
      required = Math.min(memberCount, Number(threshold));
    }
    const quorum = /^\d+$/.test(String(votePolicy.quorum ?? "")) ? Number(votePolicy.quorum) : 0;
    return { memberCount, required: Math.max(required, quorum), votePolicy };
  }

  function analyzePolicy(policy, factoryInfo, accessKeys, contractEvidence = {}) {
    const reasons = [];
    if (!contractEvidence.expectedCodeHash || contractEvidence.codeHash !== contractEvidence.expectedCodeHash) {
      reasons.push("The deployed DAO code hash does not match the reviewed SputnikDAO Testnet artifact.");
    }
    if (contractEvidence.version !== "2.3.1") {
      reasons.push("The deployed SputnikDAO interface version has not been reviewed for this integration.");
    }
    if (!policy || !Array.isArray(policy.roles)) reasons.push("The DAO policy could not be read.");
    if (!factoryInfo || factoryInfo.auto_update !== false) reasons.push("Factory auto-updates are not disabled.");
    if (!Array.isArray(accessKeys)) reasons.push("The DAO account access keys could not be checked.");
    else if (accessKeys.length) reasons.push("The DAO account still has an access key that could act outside proposals.");

    const roles = policy?.roles || [];
    const unsafe = roles.flatMap((role) => (role.permissions || []).filter((permission) => {
      const parts = permissionParts(permission);
      if (parts.proposal === "*" || parts.action === "*") return true;
      if (!ALLOWED_PROPOSAL_LABELS.has(parts.proposal)) return true;
      return parts.proposal === "transfer" && ![...VOTE_ACTIONS, "AddProposal"].includes(parts.action);
    }));
    if (unsafe.length) reasons.push("The policy includes wildcard, upgrade, policy-change, or arbitrary-call permissions.");

    const transferRoles = roles.filter((role) =>
      grants(role, "transfer", "AddProposal") || grants(role, "transfer", "VoteApprove")
    );
    if (!transferRoles.length) reasons.push("No fixed member role can propose and approve transfers.");
    if (transferRoles.length > 1) reasons.push("Transfer authority is split across multiple roles with ambiguous thresholds.");
    if (transferRoles.some((role) => !Array.isArray(role?.kind?.Group))) {
      reasons.push("Transfer authority is not limited to a fixed group of account IDs.");
    }
    const permissionedRoles = roles.filter((role) => (role?.permissions || []).length > 0);
    if (permissionedRoles.length !== 1 || permissionedRoles[0] !== transferRoles[0]) {
      reasons.push("Exactly one fixed member role must hold every retained DAO permission.");
    }

    const proposerAccounts = new Set();
    const voterAccounts = new Set();
    transferRoles.forEach((role) => {
      if (grants(role, "transfer", "AddProposal")) roleAccounts(role).forEach((id) => proposerAccounts.add(id));
      if (grants(role, "transfer", "VoteApprove")) roleAccounts(role).forEach((id) => voterAccounts.add(id));
    });
    const votingRoles = transferRoles.filter((role) => grants(role, "transfer", "VoteApprove"));
    if (votingRoles.length !== 1) reasons.push("Exactly one fixed role must hold transfer approval authority.");
    votingRoles.forEach((role) => {
      const roleThreshold = thresholdFor(policy, role);
      if (roleThreshold.memberCount < 2 || roleThreshold.required < 2) {
        reasons.push(`Transfer role ${String(role.name || "(unnamed)")} would allow unilateral approval.`);
      }
      const factoryThreshold = thresholdFor(policy, role, "factory_info_update");
      if (factoryThreshold.required < 2) {
        reasons.push(`Role ${String(role.name || "(unnamed)")} would allow unilateral factory authority changes.`);
      }
    });
    const primaryRole = votingRoles[0];
    const threshold = thresholdFor(policy, primaryRole);
    if (threshold.memberCount < 2) reasons.push("At least two voting members are required.");
    if (threshold.required < 2) reasons.push("The transfer threshold would allow one account to approve a payment.");

    return {
      ready: reasons.length === 0,
      reasons,
      members: [...new Set([...proposerAccounts, ...voterAccounts])].sort(),
      proposerAccounts,
      voterAccounts,
      requiredVotes: threshold.required,
      memberCount: threshold.memberCount,
    };
  }

  function encodeDescription(reason) {
    const purpose = String(reason || "").trim();
    if (!purpose || purpose.length > 500) throw new Error("The reason must be between 1 and 500 characters.");
    return `${DESCRIPTION_PREFIX}${JSON.stringify({ v: 1, purpose })}`;
  }

  function decodeDescription(description) {
    const text = String(description || "");
    if (!text.startsWith(DESCRIPTION_PREFIX)) return text;
    try {
      const value = JSON.parse(text.slice(DESCRIPTION_PREFIX.length));
      return String(value?.purpose || text);
    } catch (_error) {
      return text;
    }
  }

  function transferProposal(receiverId, amountYocto, reason) {
    const receiver = String(receiverId || "").trim();
    if (!/^[a-z0-9._-]{2,64}$/.test(receiver)) throw new Error("Enter a valid NEAR Testnet recipient account.");
    if (!/^\d+$/.test(String(amountYocto || "")) || BigInt(amountYocto) <= 0n) {
      throw new Error("Enter an allocation amount greater than zero.");
    }
    return {
      description: encodeDescription(reason),
      kind: { Transfer: { token_id: "", receiver_id: receiver, amount: String(amountYocto), msg: null } },
    };
  }

  function allocationFromProposal(proposal) {
    const transfer = proposal?.kind?.Transfer;
    if (!transfer || String(transfer.token_id || "") !== "") return null;
    return {
      id: Number(proposal.id),
      amount: String(transfer.amount || "0"),
      receiverId: String(transfer.receiver_id || ""),
      reason: decodeDescription(proposal.description),
      proposer: String(proposal.proposer || ""),
      status: String(proposal.status || ""),
      votes: proposal.votes || {},
      voteCounts: proposal.vote_counts || {},
      submissionTime: String(proposal.submission_time || "0"),
    };
  }

  function sumAllocations(proposals, statuses) {
    const accepted = new Set(statuses);
    return (proposals || []).reduce((total, proposal) => {
      const allocation = allocationFromProposal(proposal);
      return allocation && accepted.has(allocation.status) ? total + BigInt(allocation.amount) : total;
    }, 0n).toString();
  }

  function verifiedPayment(allocation, activity) {
    if (!allocation) return null;
    const actions = activity?.proposalTransactions?.[String(allocation.id)] || [];
    for (const action of actions) {
      if (!["VoteApprove", "Finalize"].includes(action.action)) continue;
      const transfer = (action.transfers || []).find((item) =>
        String(item.receiver) === allocation.receiverId && String(item.amount) === allocation.amount
      );
      if (transfer) return { ...action, transfer };
    }
    return null;
  }

  function goalSnapshot(goal, contributionTotal, allocations, activity) {
    if (!goal?.configured || !/^\d+$/.test(String(goal.targetYocto || ""))) return null;
    const target = BigInt(goal.targetYocto);
    if (target <= 0n || contributionTotal === null || !/^\d+$/.test(String(contributionTotal))) return null;
    const contributed = BigInt(contributionTotal);
    const goalAllocations = (allocations || []).filter((allocation) =>
      allocation && allocation.receiverId === goal.recipient
    );
    const payments = goalAllocations.map((allocation) => verifiedPayment(allocation, activity)).filter(Boolean);
    const spent = goalAllocations.reduce((total, allocation) =>
      verifiedPayment(allocation, activity) ? total + BigInt(allocation.amount) : total, 0n
    );
    const progressBasisPoints = Number((contributed * 10_000n) / target > 10_000n
      ? 10_000n
      : (contributed * 10_000n) / target);
    let status = contributed >= target ? "Target reached · proposal needed" : "Raising funds";
    if (goalAllocations.some((allocation) => allocation.status === "InProgress" && !verifiedPayment(allocation, activity))) {
      status = "Member vote in progress";
    }
    if (goalAllocations.some((allocation) => allocation.status === "Approved" && !verifiedPayment(allocation, activity))) {
      status = "Approved · payment verification pending";
    }
    if (payments.length) status = "Approved payment recorded";
    return {
      contributed: contributed.toString(),
      target: target.toString(),
      spent: spent.toString(),
      progressBasisPoints,
      status,
    };
  }

  return {
    DESCRIPTION_PREFIX,
    YOCTO_PER_NEAR,
    allocationFromProposal,
    analyzePolicy,
    decimalToYocto,
    decodeDescription,
    encodeDescription,
    formatNear,
    goalSnapshot,
    grants,
    roleAccounts,
    sumAllocations,
    thresholdFor,
    transferProposal,
    verifiedPayment,
  };
}));
