from claude_gates.hook_runner import run
from claude_gates.block import on_pre_tool_use
run(on_pre_tool_use)
