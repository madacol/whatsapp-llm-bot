

export default /** @type {defineAction} */ (x=>x)({
  name: "run_javascript",
  command: "js",
  description: "Execute JavaScript code in a secure environment. The code must be an arrow function that receives a context object.",
  parameters: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "JavaScript code to execute (must be an arrow function that accepts a context parameter). Example: '({log, db, chatId}) => { log(\"Processing\"); return \"result\"; }'",
      },
      args: {
        type: "array",
        description: "Command line arguments (for !js command)",
        items: { type: "string" }
      }
    },
    required: [],
  },
  permissions: {
    autoExecute: true
  },
  /**
   * Execute JavaScript code
   * @param {Context} context - The context object
   * @param {{code?: string, args?: string[]}} params - code to execute as an arrow function
   * @returns {Promise<any>} The result of execution
   */
  action_fn: async function (context, params) {
    // Handle both command args and LLM function call formats
    const code = params.code || (params.args && params.args.join(' '));
    console.log('Executing JavaScript code:', code);
  
    let fn;
    try {
      // Evaluate code
      fn = Function(`return ${code}`)();
    } catch (error) {
      console.error('Invalid JavaScript code: Is it a function?', {code, error});
      throw error;
    }
    if (typeof fn !== 'function') {
      console.error('fn is not a function:', {code, fn});
      throw new Error('Code must evaluate to a function');
    }
    try {
      return fn(context);
    } catch (error) {
      console.error('Error executing function:', {code, fn, error});
      throw error;
    }
  }
});