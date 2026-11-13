const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "community-directory.js"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "styles.css"), "utf8");

test("failed external cover images become a designed placeholder", () => {
  assert.match(source, /community-image-placeholder/);
  assert.match(source, /addEventListener\("error", fallback/);
  assert.match(source, /image\.complete && image\.naturalWidth === 0/);
  assert.match(styles, /\.community-card-media\.image-unavailable \.community-card-image \{ display: none/);
  assert.match(styles, /\.community-card-media\.image-unavailable \.community-image-placeholder \{ display: grid/);
});
