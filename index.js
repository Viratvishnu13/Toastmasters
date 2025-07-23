#!/usr/bin/env node

const { Command } = require('commander');
const dotenv = require('dotenv');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

dotenv.config();

const program = new Command();

program
  .name('ollama-cli')
  .description('CLI for interacting with Ollama models and coding assistance')
  .version('0.0.1');

// Define the tools for Ollama
const ollamaTools = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Reads the content of a specified file.',
      parameters: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'The path to the file to read.',
          },
        },
        required: ['filePath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Writes content to a specified file.',
      parameters: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'The path to the file to write to.',
          },
          content: {
            type: 'string',
            description: 'The content to write to the file.',
          },
        },
        required: ['filePath', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'Lists files and directories in a given path.',
      parameters: {
        type: 'object',
        properties: {
          directoryPath: {
            type: 'string',
            description: 'The path to the directory to list (defaults to current directory).',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_shell_command',
      description: 'Executes a shell command.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to execute.',
          },
        },
        required: ['command'],
      },
    },
  },
];

// Helper function to execute tools
async function executeTool(toolCall) {
  const functionName = toolCall.function.name;
  const args = JSON.parse(toolCall.function.arguments);

  console.log(`\nExecuting tool: ${functionName} with args: ${JSON.stringify(args)}`);

  try {
    switch (functionName) {
      case 'read_file': {
        const absolutePath = path.resolve(args.filePath);
        const content = fs.readFileSync(absolutePath, 'utf8');
        return { output: content };
      }
      case 'write_file': {
        const absolutePath = path.resolve(args.filePath);
        fs.writeFileSync(absolutePath, args.content);
        return { output: `Content successfully written to ${absolutePath}` };
      }
      case 'list_directory': {
        const absolutePath = path.resolve(args.directoryPath || '.');
        const files = fs.readdirSync(absolutePath);
        return { output: files.join('\n') };
      }
      case 'run_shell_command': {
        return new Promise((resolve, reject) => {
          exec(args.command, (error, stdout, stderr) => {
            if (error) {
              reject(`exec error: ${error.message}\n${stderr}`);
              return;
            }
            resolve({ output: stdout || stderr });
          });
        });
      }
      default:
        throw new Error(`Unknown tool: ${functionName}`);
    }
  } catch (error) {
    return { error: error.message };
  }
}

async function chatWithOllama(messages) {
  const ollamaApiBaseUrl = process.env.OLLAMA_API_BASE_URL || 'http://localhost:11434';
  try {
    const response = await axios.post(`${ollamaApiBaseUrl}/api/chat`, {
      model: 'llama2', // Or another Ollama model you have pulled
      messages: messages,
      stream: true,
      tools: ollamaTools, // Pass tools to Ollama
    }, {
      responseType: 'stream',
    });

    let fullResponseContent = '';
    let toolCalls = [];

    for await (const chunk of response.data) {
      const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          const message = parsed.message;

          if (message.content) {
            process.stdout.write(message.content);
            fullResponseContent += message.content;
          }
          if (message.tool_calls) {
            for (const call of message.tool_calls) {
              toolCalls.push(call);
            }
          }
        } catch (error) {
          console.error('Could not JSON parse stream message', line, error);
        }
      }
    }

    // Add the model's response to the messages history
    if (fullResponseContent) {
      messages.push({ role: 'assistant', content: fullResponseContent });
    }

    // Handle tool calls
    if (toolCalls.length > 0) {
      messages.push({ role: 'assistant', tool_calls: toolCalls });
      for (const call of toolCalls) {
        const toolOutput = await executeTool(call);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content: toolOutput.output || toolOutput.error,
        });
      }
      // Recursively call chatWithOllama with updated messages
      await chatWithOllama(messages);
    } else if (!fullResponseContent) {
        // If no content and no tool calls, it might be an empty response or an issue.
        console.log('\nOllama did not provide a text response or tool call.');
    }

  } catch (error) {
    console.error('Error communicating with Ollama API:', error.response ? error.response.data : error.message);
    console.error('Please ensure Ollama is running and the model is pulled (e.g., ollama pull llama2).');
  }
}

program.command('chat <message>')
  .description('Chat with the Ollama AI model')
  .action(async (message) => {
    console.log(`Chat message: "${message}" with Ollama`);
    const initialMessages = [{ role: 'user', content: message }];
    await chatWithOllama(initialMessages);
  });

// Keep the individual tool commands for direct use if needed
program.command('read <filePath>')
  .description('Read the content of a file')
  .action((filePath) => {
    const absolutePath = path.resolve(filePath);
    try {
      const content = fs.readFileSync(absolutePath, 'utf8');
      console.log(`Content of ${absolutePath}:\n${content}`);
    } catch (error) {
      console.error(`Error reading file ${absolutePath}: ${error.message}`);
    }
  });

program.command('write <filePath> <content>')
  .description('Write content to a file')
  .action((filePath, content) => {
    const absolutePath = path.resolve(filePath);
    try {
      fs.writeFileSync(absolutePath, content);
      console.log(`Content successfully written to ${absolutePath}`);
    } catch (error) {
      console.error(`Error writing to file ${absolutePath}: ${error.message}`);
    }
  });

program.command('ls [directoryPath]')
  .description('List files and directories in a given path (defaults to current directory)')
  .action((directoryPath) => {
    const absolutePath = path.resolve(directoryPath || '.');
    try {
      const files = fs.readdirSync(absolutePath);
      console.log(`Contents of ${absolutePath}:`);
      files.forEach(file => console.log(file));
    } catch (error) {
      console.error(`Error listing directory ${absolutePath}: ${error.message}`);
    }
  });

program.command('run <command>')
  .description('Execute a shell command')
  .action(async (command) => {
    try {
      const { exec } = require('child_process');
      exec(command, (error, stdout, stderr) => {
        if (error) {
          console.error(`exec error: ${error}`);
          return;
        }
        if (stdout) {
          console.log(`stdout:\n${stdout}`);
        }
        if (stderr) {
          console.error(`stderr:\n${stderr}`);
        }
      });
    } catch (error) {
      console.error(`Error executing command: ${error.message}`);
    }
  });

program.parse(process.argv);