import { readdir } from 'fs/promises';
import { join } from 'path';

/**
 * Execute a custom action
 * @param {string} actionName - The name of the action to execute
 * @param {Context} context - The execution context
 * @param {any} input - The input to pass to the action
 * @returns {Promise<{result: ActionResult, permissions?: any}>} Result of the action execution
 */
export async function executeAction(actionName, context, input) {
  const action = await getAction(actionName);
  if (!action) {
    throw new Error(`Action "${actionName}" not found`);
  }

  try {
    const result = await action.action_fn(context, input);
    return {
      result,
      permissions: action.permissions
    };
  } catch (error) {
    console.error(`Error executing action ${actionName}:`, error);
    throw error;
  }
}

// Log function for tools to use
function log(...args) {
  const message = args.join(' ');
  console.log(...args);
  return message;
}

/**
 * Retrieves all available actions from the actions directory
 * @returns {Promise<AppAction[]>} Array of action objects with name derived from filename
 */
export async function getActions() {
  try {
    const actionsDir = './actions';
    const files = await readdir(actionsDir);
    const jsFiles = files.filter(file => file.endsWith('.js'));
    
    const actions = await Promise.all(
      jsFiles.map(async (fileName) => {
        try {
          const filePath = join(actionsDir, fileName);
          const module = await import(`./${filePath}`);
          
          if (module.default) {
            return {
              ...module.default,
              fileName,
              app_name: ''
            };
          }

          console.error(`Action ${fileName} has no default export`);
          return null;
        } catch (importError) {
          console.error(`Error importing action ${fileName}:`, importError);
          return null;
        }
      })
    );
    
    return actions.filter(action => action !== null);
  } catch (error) {
    console.error('Error loading actions:', error);
    return [];
  }
}

/** @type {AppAction[]} */
let actions;

/**
 * Get a specific action by name
 * @param {string} actionName - The name of the action to retrieve
 * @returns {Promise<AppAction|null>} The action object or null if not found
 */
export async function getAction(actionName) {
  if (!actions) {
    actions = await getActions();
  }
  
  return actions.find(action => action.name === actionName) || null;
}