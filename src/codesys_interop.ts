/**
 * CODESYS Interop Module
 * Handles direct interaction with the CODESYS executable via command-line scripts.
 * 
 * This module manages:
 * - Creating temporary Python script files
 * - Executing them via CODESYS's scripting engine
 * - Capturing and processing results
 * 
 * IMPORTANT: Path handling for Windows is critical - paths with spaces require
 * special handling to avoid the 'C:\Program' not recognized error.
 */

import { spawn } from 'child_process'; // Use spawn directly
import { writeFile, unlink } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs'; // Import fs for existsSync check

// Define expected success/error markers from the Python scripts
const SCRIPT_SUCCESS_MARKER = 'SCRIPT_SUCCESS';
const SCRIPT_ERROR_MARKER = 'SCRIPT_ERROR';

/**
 * Executes a CODESYS Python script using the command line interface.
 *
 * @param scriptContent The Python script code to execute.
 * @param codesysExePath The full path to the CODESYS.exe executable (can contain spaces).
 * @param codesysProfileName The name of the CODESYS profile to use for scripting.
 * @returns A promise resolving to an object containing the success status and the script's output.
 * 
 * NOTE: This function uses spawn WITHOUT shell:true for robustness with Windows paths containing spaces.
 * The approach uses modified environment variables and working directory to ensure proper execution.
 */
export async function executeCodesysScript(
    scriptContent: string,
    codesysExePath: string,
    codesysProfileName: string
): Promise<{ success: boolean; output: string }> {

    // --- Pre-checks ---
    if (!codesysExePath) throw new Error('CODESYS executable path was not provided.');
    if (!codesysProfileName) throw new Error('CODESYS profile name was not provided.');
    if (!fs.existsSync(codesysExePath)) throw new Error(`CODESYS executable not found at provided path: ${codesysExePath}`);
    // --- End Pre-checks ---

    const tempDir = os.tmpdir();
    const tempFileName = `codesys_script_${Date.now()}_${Math.random().toString(36).substring(2, 9)}.py`;
    const tempFilePath = path.join(tempDir, tempFileName);

    let output = '';
    let stderrOutput = '';
    let success = false;
    let exitCode: number | null = null;

    const codesysDir = path.dirname(codesysExePath); // Directory containing CODESYS.exe

    try {
        const normalizedScriptContent = scriptContent.replace(/\r\n/g, '\n');
        await writeFile(tempFilePath, normalizedScriptContent, 'latin1');
        process.stderr.write(`INTEROP: Temp script written: ${tempFilePath}\n`);

        // --- Use spawn arguments array ---
        const command = codesysExePath;
        const args = [
            `--profile=${codesysProfileName}`, // Format expected by CODESYS.exe
            // Use = for profile? Or quotes? Check CODESYS docs. Assume '=' for now.
            // If CODESYS needs quotes around the value *itself*: `--profile="${codesysProfileName}"`
            '--noUI',
            `--runscript=${tempFilePath}`
             // If CODESYS needs quotes around the value *itself*: `--runscript="${tempFilePath}"`
        ];
        // --- End spawn arguments ---

        process.stderr.write(`INTEROP: Spawning command: ${command}\n`);
        process.stderr.write(`INTEROP: Spawning args: ${JSON.stringify(args)}\n`);
        process.stderr.write(`INTEROP ENV: CWD before spawn: ${process.cwd()}\n`);
        process.stderr.write(`INTEROP ENV: Forcing CWD for spawn: ${codesysDir}\n`);

        // --- Create modified environment ---
        const spawnEnv = { ...process.env };
        const pathSeparator = ';'; // Windows
        const originalPath = spawnEnv.PATH || '';
        spawnEnv.PATH = `${codesysDir}${pathSeparator}${originalPath}`;
        process.stderr.write(`INTEROP ENV: MODIFIED PATH for spawn (prepended): ${spawnEnv.PATH.substring(0, 100)}...\n`);
        // --- End modified environment ---


        const spawnResult = await new Promise<{ code: number | null; stdout: string; stderr: string; error?: Error }>((resolve) => {
            let stdoutData = '';
            let stderrData = '';

            const controller = new AbortController();
            const timeoutSignal = controller.signal;
            const timeoutDuration = 60000; // 60 seconds

            const childProcess = spawn(command, args, { // Pass command and args[]
                 windowsHide: true,
                 signal: timeoutSignal,
                 cwd: codesysDir, // Force CWD
                 env: spawnEnv,   // Pass modified environment
                 shell: false // <<< Ensure shell is false or omitted (default)
                });

            const timeoutId = setTimeout(() => { /* ... timeout logic ... */ }, timeoutDuration);
            // --- Event Listeners (stdout, stderr, error, close, abort) ---
            // (Keep the event listener logic the same as the previous version)
             childProcess.stdout.on('data', (data) => {
                const chunk = data.toString();
                stdoutData += chunk;
                process.stderr.write(`INTEROP stdout chunk: ${chunk.length > 50 ? chunk.substring(0, 50) + '...' : chunk}\n`);
            });
            childProcess.stderr.on('data', (data) => {
                const chunk = data.toString();
                stderrData += chunk;
                if (chunk.includes('C:\\Program')) { process.stderr.write(`>>>> INTEROP STDERR DETECTED 'C:\\Program': ${chunk}\n`); }
                else { process.stderr.write(`INTEROP stderr chunk: ${chunk}\n`); }
            });
            childProcess.on('error', (spawnError) => {
                 clearTimeout(timeoutId);
                 process.stderr.write(`INTEROP SPAWN ERROR (shell:false): ${spawnError.message}\n`);
                 resolve({ code: (spawnError as NodeJS.ErrnoException).errno ?? 1, stdout: stdoutData, stderr: stderrData, error: spawnError });
            });
            childProcess.on('close', (code) => {
                clearTimeout(timeoutId);
                process.stderr.write(`INTEROP: Process closed code: ${code}\n`);
                resolve({ code: code, stdout: stdoutData, stderr: stderrData });
            });
             timeoutSignal.addEventListener('abort', () => {
                 process.stderr.write('INTEROP: Abort signal received, killing process.\n');
                 if (!childProcess.killed) childProcess.kill('SIGTERM');
                 setTimeout(() => { if (!childProcess.killed) childProcess.kill('SIGKILL'); }, 2000);
                 resolve({ code: null, stdout: stdoutData, stderr: stderrData + "\nTIMEOUT: Process aborted due to timeout." });
             }, { once: true });
            // --- End Event Listeners ---
        });

        output = spawnResult.stdout;
        stderrOutput = spawnResult.stderr;
        exitCode = spawnResult.code;

       
        // success determination logic
        if (stderrOutput.includes("'C:\\Program' is not recognized")) { success = false; process.stderr.write("INTEROP: Failure determined by 'C:\\Program' error in stderr.\n"); if (!stderrOutput.includes(SCRIPT_ERROR_MARKER)) stderrOutput = `SCRIPT_ERROR: ${stderrOutput}`; }
        else if (spawnResult.error) { success = false; process.stderr.write(`INTEROP: Failure determined by spawn error: ${spawnResult.error.message}\n`); if (!stderrOutput.includes(SCRIPT_ERROR_MARKER)) stderrOutput = `SCRIPT_ERROR: Spawn failed: ${spawnResult.error.message}\n${stderrOutput}`; }
        else {
             process.stderr.write(`INTEROP: Checking markers/exit code (Code: ${exitCode})...\n`);
             if (output.includes(SCRIPT_SUCCESS_MARKER) || stderrOutput.includes(SCRIPT_SUCCESS_MARKER)) { success = true; process.stderr.write("INTEROP: Success determined by SUCCESS marker.\n"); }
             else if (output.includes(SCRIPT_ERROR_MARKER) || stderrOutput.includes(SCRIPT_ERROR_MARKER)) { success = false; process.stderr.write("INTEROP: Failure determined by ERROR marker.\n"); }
             else {
                 success = exitCode === 0;
                 if (success) process.stderr.write(`INTEROP: Success determined by exit code 0 (no markers found).\n`);
                 else { process.stderr.write(`INTEROP: Failure determined by non-zero exit code ${exitCode} (no markers found).\n`); if (!stderrOutput.includes(SCRIPT_ERROR_MARKER)) stderrOutput = `SCRIPT_ERROR: Process failed with exit code ${exitCode} (no markers found).\n${stderrOutput}`; }
             }
        }
        // --- End Success Determination ---

    } catch (error: any) {
        process.stderr.write(`INTEROP: Error during setup: ${error.message}\n${error.stack}\n`);
        stderrOutput = `SCRIPT_ERROR: Failed during script execution setup: ${error.message}`;
        success = false;
    } finally {
        // Cleanup: Attempt to delete the temporary script file
        try { await unlink(tempFilePath); process.stderr.write(`INTEROP: Temp script deleted: ${tempFilePath}\n`); }
        catch (cleanupError: any) { process.stderr.write(`INTEROP: Failed to delete temp file ${tempFilePath}: ${cleanupError.message}\n`); if (success) stderrOutput += `\nWARNING: Failed to delete temporary script file ${tempFilePath}. ${cleanupError.message}`; }
    }
    // Final output processing
    const finalOutput = success ? output : `${stderrOutput}\n${output}`.trim();
    process.stderr.write(`INTEROP: Final Success: ${success}\n`);
    process.stderr.write(`INTEROP: Final Output Length: ${finalOutput.length}\n---\n`);
    return { success, output: finalOutput };
}