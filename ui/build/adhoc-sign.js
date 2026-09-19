// Apple Silicon refuses to launch an unsigned arm64 app ("damaged"); an ad-hoc
// signature is enough for a locally installed, non-notarised app.
const path = require("node:path");
const { execFileSync } = require("node:child_process");

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
};
