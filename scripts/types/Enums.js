"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentRole = exports.StepStatus = exports.PipelineStatus = exports.StepType = exports.Verdict = void 0;
var Verdict;
(function (Verdict) {
    Verdict["Pass"] = "PASS";
    Verdict["Revise"] = "REVISE";
    Verdict["Fail"] = "FAIL";
    Verdict["Unknown"] = "UNKNOWN";
    Verdict["Converged"] = "CONVERGED";
})(Verdict || (exports.Verdict = Verdict = {}));
var StepType;
(function (StepType) {
    StepType["Check"] = "CHECK";
    StepType["Verify"] = "VERIFY";
    StepType["VerifyWithFixer"] = "VERIFY_W_FIXER";
    StepType["Transform"] = "TRANSFORM";
})(StepType || (exports.StepType = StepType = {}));
var PipelineStatus;
(function (PipelineStatus) {
    PipelineStatus["Normal"] = "normal";
    PipelineStatus["Revision"] = "revision";
    PipelineStatus["Completed"] = "completed";
    PipelineStatus["Failed"] = "failed";
})(PipelineStatus || (exports.PipelineStatus = PipelineStatus = {}));
var StepStatus;
(function (StepStatus) {
    StepStatus["Pending"] = "pending";
    StepStatus["Active"] = "active";
    StepStatus["Passed"] = "passed";
    StepStatus["Revise"] = "revise";
    StepStatus["Fix"] = "fix";
    StepStatus["Failed"] = "failed";
})(StepStatus || (exports.StepStatus = StepStatus = {}));
var AgentRole;
(function (AgentRole) {
    AgentRole["Source"] = "source";
    AgentRole["Checker"] = "checker";
    AgentRole["Verifier"] = "verifier";
    AgentRole["Fixer"] = "fixer";
    AgentRole["Transformer"] = "transformer";
    AgentRole["Ungated"] = "ungated";
})(AgentRole || (exports.AgentRole = AgentRole = {}));
//# sourceMappingURL=Enums.js.map