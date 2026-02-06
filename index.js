#!/usr/bin/env node

/**
 * Figma MCP Compiler
 * Entry point - uses original working compiler
 */

require('dotenv').config();

const MCPCompiler = require('./mcp-compiler');

const port = parseInt(process.argv[2]) || 3000;
const compiler = new MCPCompiler();
compiler.start(port);
