import { spawn } from 'child_process';
import * as path from 'path';

// A counter for JSON-RPC request IDs
let rpcIdCounter = 1;

/**
 * A helper function to format and send the final response to stdout,
 * adhering to the VCP protocol.
 * @param status 'success' or 'error'
 * @param data The result or error object
 */
function sendVcpResponse(status: 'success' | 'error', data: any): void {
  const response = { status };
  if (status === 'success') {
    response.result = data;
  } else {
    response.error = data;
  }
  // Ensure we only print one response to stdout
  if (!process.stdout.writableEnded) {
    console.log(JSON.stringify(response));
    process.stdout.end();
  }
}

/**
 * Main function for the VCP adapter.
 * Spawns the MCP proxy as a child process and translates communication
 * between the VCP host and the MCP child process.
 */
async function main() {
  let vcpInput = '';
  try {
    // 1. Read the VCP request from this process's stdin
    for await (const chunk of process.stdin) {
      vcpInput += chunk;
    }
    if (vcpInput.trim() === '') {
      throw new Error('VCP adapter received empty stdin.');
    }

    const vcpArgs = JSON.parse(vcpInput);
    const { tool_to_call, tool_arguments } = vcpArgs;

    if (!tool_to_call) {
      throw new Error("VCP input JSON must include a 'tool_to_call' property.");
    }

    // 2. Construct the MCP JSON-RPC request
    // The MCP proxy itself has two main tools: `get_tools` and `tool_call`.
    // We map the VCP request to the appropriate MCP method.
    const mcpMethod = tool_to_call === 'get_tools' ? 'tools/list' : 'tools/call';
    const mcpParams = tool_to_call === 'get_tools'
        ? (tool_arguments || {})
        : { name: tool_to_call, arguments: tool_arguments || {} };

    const mcpRequest = {
      jsonrpc: '2.0',
      method: mcpMethod,
      params: mcpParams,
      id: rpcIdCounter++,
    };

    // 3. Spawn the MCP proxy server as a child process
    const child = spawn('node', [path.resolve(process.cwd(), 'dist/index.js')], {
      env: { ...process.env }, // Pass environment variables
      stdio: ['pipe', 'pipe', 'pipe'], // Use pipes for communication
    });

    let stdoutData = '';
    let stderrData = '';
    let responseSent = false;

    // Set a timeout to prevent the process from hanging indefinitely
    const timeout = setTimeout(() => {
      if (!responseSent) {
        sendVcpResponse('error', { message: 'Adapter timeout: The MCP child process took too long to respond.', stderr: stderrData });
        child.kill('SIGKILL'); // Force kill the child process
      }
    }, 55000); // Slightly less than the manifest timeout of 60s

    // 4. Listen for output from the child process
    child.stdout.on('data', (data) => {
      stdoutData += data.toString();
      // An MCP server can send multiple JSON-RPC messages. We look for the one that matches our request ID.
      try {
        // Poor man's JSON stream parsing: find the response for our ID.
        const lines = stdoutData.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            const mcpResponse = JSON.parse(line);
            if (mcpResponse.id === mcpRequest.id) {
              responseSent = true;
              clearTimeout(timeout); // Clear the timeout as we got a response

              // 5. Translate MCP response to VCP format
              if (mcpResponse.error) {
                sendVcpResponse('error', mcpResponse.error);
              } else {
                // The MCP 'tools/call' result is already in the VCP multimodal format.
                // The 'tools/list' result needs to be wrapped.
                const result = mcpResponse.result.content
                    ? mcpResponse.result
                    : { content: [{ type: 'text', text: JSON.stringify(mcpResponse.result, null, 2) }] };
                sendVcpResponse('success', result);
              }
              child.kill(); // We got our response, we can kill the child.
              break;
            }
          }
        }
      } catch (e) {
        // Ignore parsing errors until we have the full response
      }
    });

    child.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    child.on('close', (code) => {
      if (!responseSent) {
        // If the process closes without sending a response, report an error.
        clearTimeout(timeout);
        sendVcpResponse('error', {
          message: `MCP child process exited prematurely with code ${code}.`,
          stderr: stderrData,
        });
      }
    });

    // 6. Write the MCP request to the child's stdin
    child.stdin.write(JSON.stringify(mcpRequest) + '\n');
    child.stdin.end();

  } catch (e: any) {
    sendVcpResponse('error', {
      message: `VCP Adapter Error: ${e.message}`,
      stack: e.stack,
      receivedInput: vcpInput,
    });
  }
}

main();
