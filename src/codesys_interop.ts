import { spawn } from 'child_process';
import { writeFile, unlink } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Define expected success/error markers from the Python scripts
const SCRIPT_SUCCESS_MARKER = 'SCRIPT_SUCCESS';
const SCRIPT_ERROR_MARKER = 'SCRIPT_ERROR';

/**
 * Executes a CODESYS Python script using the command line interface.
 *
 * @param scriptContent The Python script code to execute.
 * @param codesysExePath The full path to the CODESYS.exe executable.
 * @param codesysProfileName The name of the CODESYS profile to use for scripting.
 * @returns A promise resolving to an object containing the success status and the script's output.
 */
export async function executeCodesysScript(
    scriptContent: string,
    codesysExePath: string,
    codesysProfileName: string
): Promise<{ success: boolean; output: string }> { // Revert return type

    // Validate arguments passed to the function
    if (!codesysExePath) {
        throw new Error('CODESYS executable path was not provided to executeCodesysScript.');
    }
    if (!codesysProfileName) {
        throw new Error('CODESYS profile name was not provided to executeCodesysScript.');
    }

    // Create a temporary file for the script
    const tempDir = os.tmpdir();
    const tempFileName = `codesys_script_${Date.now()}_${Math.random().toString(36).substring(7)}.py`;
    const tempFilePath = path.join(tempDir, tempFileName);

    let output = '';
    let success = false;

    try {
        // Normalize line endings to LF (\n)
        const normalizedScriptContent = scriptContent.replace(/\r\n/g, '\n');
        // Write the script content to the temporary file using latin1 encoding
        await writeFile(tempFilePath, normalizedScriptContent, 'latin1'); // Explicitly use latin1
        process.stderr.write(`Temporary script written to: ${tempFilePath} with latin1 encoding and LF line endings\n`); // Use process.stderr

        // Add --additionalfolder argument
        const additionalFolderPath = "C:\\Program Files\\CODESYS 3.5.21.0\\CODESYS\\AdditionalFolders\\Default"; // Assuming Default instance
        
        // Fix: Use shell:true and pass the entire command as a single string without additionalfolder
        const commandWithArgs = `"${codesysExePath}" --profile="${codesysProfileName}" --noUI --runscript="${tempFilePath}"`;

        process.stderr.write(`Executing: ${commandWithArgs}\n`); // Log the command string

        // Spawn the CODESYS process using shell:true for proper argument handling
        const codesysProcess = spawn(commandWithArgs, {
            stdio: ['ignore', 'pipe', 'pipe'], // Ignore stdin, pipe stdout and stderr
            shell: true // Use shell to handle the command string properly
        });

        // Capture stdout
        codesysProcess.stdout.on('data', (data) => {
            const chunk = data.toString();
            // console.error('CODESYS stdout:', chunk); // Optional: Original debug log
            output += chunk;
        });

        // Capture stderr
        codesysProcess.stderr.on('data', (data) => {
            const chunk = data.toString();
            process.stderr.write(`CODESYS stderr: ${chunk}\n`); // Use process.stderr
            output += chunk; // Include stderr in the output for debugging
        });

        // Wait for the process to exit with a timeout
        const exitCode = await new Promise<number>((resolve, reject) => {
            // Add timeout handling
            const timeoutMs = 30000; // 30 seconds
            const timeout = setTimeout(() => {
                process.stderr.write(`TIMEOUT: CODESYS process did not complete in ${timeoutMs}ms\n`);
                // Force resolve with 0 to proceed with parsing output collected so far
                codesysProcess.kill();
                resolve(0);
            }, timeoutMs);
            
            codesysProcess.on('close', (code) => {
                clearTimeout(timeout);
                resolve(code ?? 0);
            });
            codesysProcess.on('error', (err) => {
                 clearTimeout(timeout);
                 // Error starting the process itself (e.g., command not found)
                 process.stderr.write(`Failed to start CODESYS process: ${err.message}\n`); // Use process.stderr
                 reject(err);
            });
        });

        process.stderr.write(`CODESYS process exited with code: ${exitCode}\n`); // Use process.stderr

        // Determine success based on exit code and output markers
        // Note: CODESYS scripting might return exit code 0 even if the script had logical errors.
        // Relying on specific output markers is more robust.
        if (output.includes(SCRIPT_SUCCESS_MARKER)) {
            success = true;
        } else if (output.includes(SCRIPT_ERROR_MARKER)) {
            success = false;
        } else {
            // If no markers found, fall back to exit code (less reliable)
            success = exitCode === 0;
            if (!success) {
                // Append the specific CODESYS error if available and no other marker found
                if (!output.includes(SCRIPT_ERROR_MARKER)) {
                     output += `\nSCRIPT_ERROR: Process exited with non-zero code ${exitCode}. Check CODESYS stderr output above for details.`;
                } else {
                     output += `\nSCRIPT_ERROR: Process exited with non-zero code ${exitCode}.`;
                }
            } else {
                 // If exit code is 0 but no success marker, treat as potential issue or simple script
                 console.error("Warning: CODESYS script finished with exit code 0 but no SCRIPT_SUCCESS marker found."); // Log warning to stderr
                 // Optionally, you could treat this as success or failure depending on requirements
                 // For now, let's assume success if exit code is 0 and no error marker.
                 if (!output.includes(SCRIPT_ERROR_MARKER)) {
                    success = true;
                 }
            }
        }

    } catch (error: any) {
        process.stderr.write(`Error executing CODESYS script: ${error}\n`); // Use process.stderr
        output += `\nSCRIPT_ERROR: Failed to execute script process. ${error.message}`;
        success = false;
    } finally {
        // Clean up the temporary file
        try {
            await unlink(tempFilePath);
            process.stderr.write(`Temporary script deleted: ${tempFilePath}\n`); // Use process.stderr
        } catch (cleanupError: any) {
            process.stderr.write(`Failed to delete temporary script file ${tempFilePath}: ${cleanupError}\n`); // Use process.stderr
            // Don't overwrite the original error if cleanup fails
            if (success) { // Only add cleanup error if the main process didn't already fail
               output += `\nWARNING: Failed to delete temporary script file ${tempFilePath}. ${cleanupError.message}`;
            }
        }
    }

    process.stderr.write(`Final script output received:\n---\n${output}\n---\n`); // Use process.stderr
    return { success, output }; // Revert return object
}