"use strict";
// py.cjs — Node wrapper that discovers Python >= 3.11 and execs a .py hook script.
// Fail-open: any error exits 0 so Claude Code hooks are never hard-blocked.
const { execFileSync, spawnSync } = require("child_process");
const path = require("path");

const script = process.argv[2];
if (!script)
{
    process.stderr.write("py.cjs: no script argument\n");
    process.exit(0);
}

function tryPython(bin)
{
    try
    {
        const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
        if (r.status !== 0 || r.error) return null;
        const ver = (r.stdout || r.stderr || "").match(/Python (\d+)\.(\d+)/);
        if (!ver) return null;
        const [, major, minor] = ver.map(Number);
        return (major > 3 || (major === 3 && minor >= 11)) ? bin : null;
    }
    catch (_) { return null; }
}

const pyBin = tryPython("python3") || tryPython("python");
if (!pyBin)
{
    process.stderr.write("py.cjs: Python >= 3.11 not found — skipping\n");
    process.exit(0);
}

// Resolve: absolute paths pass through; bare names resolve relative to scripts/
const scriptPath = path.isAbsolute(script) ? script : path.join(__dirname, script);

// Inject src/ into PYTHONPATH so claude_gates is importable before hook_runner sets sys.path
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, "..");
const srcPath = path.join(pluginRoot, "src");
const sep = process.platform === "win32" ? ";" : ":";
const existingPP = process.env.PYTHONPATH || "";
const pyEnv = Object.assign({}, process.env, {
    PYTHONPATH: existingPP ? `${srcPath}${sep}${existingPP}` : srcPath,
});

try
{
    execFileSync(pyBin, [scriptPath], { stdio: "inherit", env: pyEnv });
}
catch (e)
{
    // Fail-open: hook errors must not block Claude Code
    process.stderr.write(`py.cjs: ${script} exited with error — ${e.message}\n`);
    process.exit(0);
}
