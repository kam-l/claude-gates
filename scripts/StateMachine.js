"use strict";
/**
 * Test helper — thin wrapper providing the (db, scope, ...) calling convention
 * used by pipeline-test.ts, test-pipeline-e2e.ts, and benchmark.ts.
 *
 * Production hooks import PipelineEngine directly.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPipeline = createPipeline;
exports.getAllNextActions = getAllNextActions;
exports.getNextAction = getNextAction;
exports.resolveRole = resolveRole;
exports.retryGateAgent = retryGateAgent;
exports.step = step;
const PipelineEngine_1 = require("./PipelineEngine");
const PipelineRepository_1 = require("./PipelineRepository");
function createPipeline(db, scope, sourceAgent, steps) {
    new PipelineEngine_1.PipelineEngine(new PipelineRepository_1.PipelineRepository(db)).createPipeline(scope, sourceAgent, steps);
}
function step(db, scope, input) {
    return new PipelineEngine_1.PipelineEngine(new PipelineRepository_1.PipelineRepository(db)).step(scope, input);
}
function retryGateAgent(db, scope) {
    return new PipelineEngine_1.PipelineEngine(new PipelineRepository_1.PipelineRepository(db)).retryGateAgent(scope);
}
function getNextAction(db, scope) {
    return new PipelineEngine_1.PipelineEngine(new PipelineRepository_1.PipelineRepository(db)).getNextAction(scope);
}
function getAllNextActions(db) {
    return new PipelineEngine_1.PipelineEngine(new PipelineRepository_1.PipelineRepository(db)).getAllNextActions();
}
function resolveRole(db, scope, agentType) {
    return new PipelineEngine_1.PipelineEngine(new PipelineRepository_1.PipelineRepository(db)).resolveRole(scope, agentType);
}
//# sourceMappingURL=StateMachine.js.map