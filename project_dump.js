const fs = require("fs");
const path = require("path");

// folders we should ignore
const ignoreDirs = ["node_modules", ".git", "dist", "build", ".next", ".turbo", "out", "coverage", "logs", "public"];

// only include code/config files
const allowedExtensions = [
  ".js", ".ts", ".tsx", ".jsx", ".json",
  ".md", ".css", ".scss", ".html", ".env", ".example"
];

function dumpProject(dir, outputFile) {
  const out = fs.createWriteStream(outputFile, { encoding: "utf-8" });

  function walk(currentPath) {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      if (ignoreDirs.includes(entry.name)) continue;

      const fullPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (!allowedExtensions.includes(ext)) continue;

        const relPath = path.relative(dir, fullPath);
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          out.write(`\n\n===== FILE: ${relPath} =====\n\n`);
          out.write(content);
        } catch {
          out.write(`\n\n===== FILE: ${relPath} (SKIPPED - unreadable) =====\n\n`);
        }
      }
    }
  }

  walk(dir);
  out.end();
}

dumpProject(process.cwd(), "project_dump.txt");