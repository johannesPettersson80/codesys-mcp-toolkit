/**
 * Script Loader Module
 * Centralizes loading and management of Python script templates
 * 
 * This module:
 * - Loads script templates from the /scripts directory
 * - Provides script template interpolation functions
 * - Manages script parameter substitution
 */

import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const readFileAsync = promisify(fs.readFile);
const SCRIPTS_DIR = path.join(__dirname, 'scripts');

// Cache for loaded scripts to avoid repeated file system access
const scriptCache: Record<string, string> = {};

/**
 * Loads a script template from the scripts directory
 * @param scriptName The name of the script file (without .py extension)
 * @returns The script content as a string
 */
export async function loadScriptTemplate(scriptName: string): Promise<string> {
    // Add .py extension if not provided
    const fileName = scriptName.endsWith('.py') ? scriptName : `${scriptName}.py`;
    const filePath = path.join(SCRIPTS_DIR, fileName);
    
    // Return from cache if available
    if (scriptCache[fileName]) {
        return scriptCache[fileName];
    }
    
    try {
        const content = await readFileAsync(filePath, 'utf8');
        // Store in cache for future use
        scriptCache[fileName] = content;
        return content;
    } catch (error: any) {
        throw new Error(`Failed to load script template '${fileName}': ${error.message}`);
    }
}

/**
 * Loads a script template synchronously (for use during startup)
 * @param scriptName The name of the script file (without .py extension)
 * @returns The script content as a string
 */
export function loadScriptTemplateSync(scriptName: string): string {
    // Add .py extension if not provided
    const fileName = scriptName.endsWith('.py') ? scriptName : `${scriptName}.py`;
    const filePath = path.join(SCRIPTS_DIR, fileName);
    
    // Return from cache if available
    if (scriptCache[fileName]) {
        return scriptCache[fileName];
    }
    
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        // Store in cache for future use
        scriptCache[fileName] = content;
        return content;
    } catch (error: any) {
        throw new Error(`Failed to load script template '${fileName}': ${error.message}`);
    }
}

/**
 * Interpolates parameters into a script template
 * @param template The script template string
 * @param params Object containing parameter names and values
 * @returns The script with parameter values substituted
 */
export function interpolateScript(template: string, params: Record<string, string>): string {
    let result = template;
    
    // Replace each parameter in the template
    for (const [key, value] of Object.entries(params)) {
        // Convert value to string and escape backslashes for Python
        const escapedValue = String(value).replace(/\\/g, '\\\\');
        
        // Replace {PARAM_NAME} with the escaped value
        const paramPattern = new RegExp(`\\{${key}\\}`, 'g');
        result = result.replace(paramPattern, escapedValue);
    }
    
    return result;
}

/**
 * Combines multiple script fragments with proper indentation
 * @param scripts Object containing named script fragments
 * @returns Combined script content
 */
export function combineScripts(scripts: Record<string, string>): string {
    return Object.values(scripts).join('\n\n');
}

/**
 * Load all script templates from the scripts directory
 * This is useful during development to preload the cache
 */
export async function preloadAllScriptTemplates(): Promise<void> {
    try {
        const files = fs.readdirSync(SCRIPTS_DIR);
        for (const file of files) {
            if (file.endsWith('.py')) {
                await loadScriptTemplate(file);
            }
        }
    } catch (error: any) {
        console.error(`Failed to preload script templates: ${error.message}`);
    }
}
