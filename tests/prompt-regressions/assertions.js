import { resolveModel } from "../../model-roles.js";

/**
 * @typedef {
 *   | { type: "tool_call"; tool_name: string }
 *   | { type: "no_tool_call"; tool_name: string }
 *   | { type: "contains"; value: string }
 *   | { type: "not_contains"; value: string }
 *   | { type: "llm_judge"; criteria: string }
 * } TestAssertion
 */

/**
 * Check a single assertion against an LLM response.
 * @param {TestAssertion} assertion
 * @param {LlmChatResponse} response
 * @param {CallLlm} callLlm
 * @returns {Promise<{ passed: boolean; message: string }>}
 */
export async function checkAssertion(assertion, response, callLlm) {
  switch (assertion.type) {
    case "tool_call": {
      const found = response.toolCalls?.some(
        (tc) => tc.name === assertion.tool_name,
      );
      return {
        passed: !!found,
        message: found
          ? `Called ${assertion.tool_name}`
          : `Expected tool call to ${assertion.tool_name}, got: ${
              response.toolCalls?.map((tc) => tc.name).join(", ") || "none"
            }`,
      };
    }
    case "no_tool_call": {
      const found = response.toolCalls?.some(
        (tc) => tc.name === assertion.tool_name,
      );
      return {
        passed: !found,
        message: found
          ? `Expected NO call to ${assertion.tool_name}, but it was called`
          : `Correctly did not call ${assertion.tool_name}`,
      };
    }
    case "contains": {
      const content = response.content || "";
      const passed = content.includes(assertion.value);
      return {
        passed,
        message: passed
          ? `Response contains "${assertion.value}"`
          : `Response does not contain "${assertion.value}"`,
      };
    }
    case "not_contains": {
      const content = response.content || "";
      const passed = !content.includes(assertion.value);
      return {
        passed,
        message: passed
          ? `Response correctly omits "${assertion.value}"`
          : `Response unexpectedly contains "${assertion.value}"`,
      };
    }
    case "llm_judge": {
      const judgeResponse = await callLlm(
        `Given this LLM response:\n\n${JSON.stringify({ content: response.content, toolCalls: response.toolCalls })}\n\nDoes it satisfy this criteria: ${assertion.criteria}\n\nAnswer only YES or NO.`,
        { model: resolveModel("fast") },
      );
      const answer = typeof judgeResponse === "string" ? judgeResponse : "";
      const passed = answer.trim().toUpperCase().startsWith("YES");
      return {
        passed,
        message: passed
          ? `LLM judge: criteria satisfied`
          : `LLM judge: criteria NOT satisfied — "${answer}"`,
      };
    }
    default: {
      const _exhaustive = /** @type {never} */ (assertion);
      throw new Error(`Unknown assertion type: ${/** @type {{type:string}} */ (_exhaustive).type}`);
    }
  }
}
