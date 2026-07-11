/**
 * AgentEventLoop — 向后兼容的薄封装。
 *
 * v3.0 重命名为 AgentHarness，本文件作为别名保持 API 兼容。
 *
 * @deprecated 请改用 AgentHarness（来自 harness/AgentHarness.ts）
 * @see AgentHarness
 */

/**
 * 重新导出 AgentHarness 及其 AgentEventLoop 别名。
 */
export { AgentHarness, AgentHarness as AgentEventLoop } from '../harness/AgentHarness.ts';
