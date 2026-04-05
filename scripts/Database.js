"use strict";
/**
 * Test helper — thin wrapper providing the (db, scope, ...) calling convention
 * used by pipeline-test.ts, test-pipeline-e2e.ts, and benchmark.ts.
 *
 * Production hooks import PipelineRepository/SessionManager directly.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSessionDir = exports.agentRunningMarker = void 0;
exports.addEdit = addEdit;
exports.addToolHash = addToolHash;
exports.deletePipeline = deletePipeline;
exports.findAgentScope = findAgentScope;
exports.getActivePipelines = getActivePipelines;
exports.getActiveStep = getActiveStep;
exports.getAgent = getAgent;
exports.getDb = getDb;
exports.getEditCounts = getEditCounts;
exports.getEdits = getEdits;
exports.getLastNHashes = getLastNHashes;
exports.getPending = getPending;
exports.getPipelineState = getPipelineState;
exports.getStep = getStep;
exports.getStepByStatus = getStepByStatus;
exports.getSteps = getSteps;
exports.hasNonPassedSteps = hasNonPassedSteps;
exports.insertPipeline = insertPipeline;
exports.insertStep = insertStep;
exports.isCleared = isCleared;
exports.pipelineExists = pipelineExists;
exports.registerAgent = registerAgent;
exports.setVerdict = setVerdict;
exports.updatePipelineState = updatePipelineState;
exports.updateStepStatus = updateStepStatus;
const PipelineRepository_1 = require("./PipelineRepository");
const SessionManager_1 = require("./SessionManager");
function getDb(sessionDir) {
    const db = SessionManager_1.SessionManager.openDatabase(sessionDir);
    PipelineRepository_1.PipelineRepository.initSchema(db);
    return db;
}
// Wrapper functions that create a temporary repo instance
function insertPipeline(db, scope, sourceAgent, totalSteps) {
    new PipelineRepository_1.PipelineRepository(db).insertPipeline(scope, sourceAgent, totalSteps);
}
function insertStep(db, scope, stepIndex, step, sourceAgent) {
    new PipelineRepository_1.PipelineRepository(db).insertStep(scope, stepIndex, step, sourceAgent);
}
function pipelineExists(db, scope) {
    return new PipelineRepository_1.PipelineRepository(db).pipelineExists(scope);
}
function getStep(db, scope, stepIndex) {
    return new PipelineRepository_1.PipelineRepository(db).getStep(scope, stepIndex);
}
function getActiveStep(db, scope) {
    return new PipelineRepository_1.PipelineRepository(db).getActiveStep(scope);
}
function getStepByStatus(db, scope, status) {
    return new PipelineRepository_1.PipelineRepository(db).getStepByStatus(scope, status);
}
function getSteps(db, scope) {
    return new PipelineRepository_1.PipelineRepository(db).getSteps(scope);
}
function getPipelineState(db, scope) {
    return new PipelineRepository_1.PipelineRepository(db).getPipelineState(scope);
}
function updateStepStatus(db, scope, stepIndex, status, round) {
    new PipelineRepository_1.PipelineRepository(db).updateStepStatus(scope, stepIndex, status, round);
}
function updatePipelineState(db, scope, updates) {
    new PipelineRepository_1.PipelineRepository(db).updatePipelineState(scope, updates);
}
function deletePipeline(db, scope) {
    new PipelineRepository_1.PipelineRepository(db).deletePipeline(scope);
}
function getActivePipelines(db) {
    return new PipelineRepository_1.PipelineRepository(db).getActivePipelines();
}
function hasNonPassedSteps(db, scope) {
    return new PipelineRepository_1.PipelineRepository(db).hasNonPassedSteps(scope);
}
function registerAgent(db, scope, agent, outputFilepath) {
    new PipelineRepository_1.PipelineRepository(db).registerAgent(scope, agent, outputFilepath);
}
function setVerdict(db, scope, agent, verdict, round, check) {
    new PipelineRepository_1.PipelineRepository(db).setVerdict(scope, agent, verdict, round, check);
}
function getAgent(db, scope, agent) {
    return new PipelineRepository_1.PipelineRepository(db).getAgent(scope, agent);
}
function isCleared(db, scope, agent) {
    return new PipelineRepository_1.PipelineRepository(db).isCleared(scope, agent);
}
function findAgentScope(db, agent) {
    return new PipelineRepository_1.PipelineRepository(db).findAgentScope(agent);
}
function getPending(db, agent) {
    return new PipelineRepository_1.PipelineRepository(db).getPending(agent);
}
function addEdit(db, filepath, lines) {
    new PipelineRepository_1.PipelineRepository(db).addEdit(filepath, lines);
}
function getEdits(db) {
    return new PipelineRepository_1.PipelineRepository(db).getEdits();
}
function getEditCounts(db) {
    return new PipelineRepository_1.PipelineRepository(db).getEditCounts();
}
function addToolHash(db, hash) {
    new PipelineRepository_1.PipelineRepository(db).addToolHash(hash);
}
function getLastNHashes(db, n) {
    return new PipelineRepository_1.PipelineRepository(db).getLastNHashes(n);
}
const getSessionDir = SessionManager_1.SessionManager.getSessionDir;
exports.getSessionDir = getSessionDir;
const agentRunningMarker = SessionManager_1.SessionManager.agentRunningMarker;
exports.agentRunningMarker = agentRunningMarker;
//# sourceMappingURL=Database.js.map