import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const projectRoot = process.cwd();
const distDir = path.join(projectRoot, "dist");

function findBuiltApp(searchRoot) {
  if (!fs.existsSync(searchRoot)) return null;

  const queue = [searchRoot];
  while (queue.length > 0) {
    const current = queue.shift();
    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory() && entry.name.endsWith(".app")) {
        return fullPath;
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      queue.push(path.join(current, entry.name));
    }
  }

  return null;
}

const appBundlePath = findBuiltApp(distDir);

if (!appBundlePath) {
  console.error("No built macOS app bundle was found in dist/.");
  process.exit(1);
}

execFileSync("open", [appBundlePath], { stdio: "inherit" });

