/**
 * Figma MCP Client
 * Connects to the Figma MCP server and provides a clean API
 * Supports both real MCP server and direct Figma API fallback
 */

require('dotenv').config();
const fetch = require('node-fetch');

class FigmaMCPClient {
  constructor(serverConfig = {}) {
    this.serverConfig = {
      url: serverConfig.url || process.env.MCP_SERVER_URL || 'http://localhost:3000',
      timeout: serverConfig.timeout || parseInt(process.env.MCP_SERVER_TIMEOUT) || 10000,
      ...serverConfig
    };
    this.connected = false;
    this.useDirectAPI = false; // Fallback to direct Figma API
  }

  /**
   * Connect to the Figma MCP server
   * Falls back to direct Figma API if MCP server is unavailable
   */
  async connect() {
    console.log('🔌 Connecting to Figma service...');
    
    // Try mock data first for testing
    if (process.env.USE_MOCK_DATA === 'true') {
      console.log('🧪 Using mock data for testing');
      this.connected = true;
      this.useDirectAPI = false;
      return;
    }
    
    try {
      // Try MCP server first
      await this._testMCPConnection();
      this.connected = true;
      this.useDirectAPI = false;
      console.log('✅ Connected to Figma MCP server');
    } catch (mcpError) {
      console.log('⚠️  MCP server unavailable, trying direct Figma API...');
      
      try {
        // Fallback to direct Figma API
        await this._testDirectAPI();
        this.connected = true;
        this.useDirectAPI = true;
        console.log('✅ Connected to Figma API directly');
      } catch (apiError) {
        console.log('⚠️  Direct API unavailable, using mock data for testing...');
        this.connected = true;
        this.useDirectAPI = false;
        console.log('🧪 Mock mode enabled - add real FIGMA_ACCESS_TOKEN to use live data');
      }
    }
  }

  /**
   * Call a tool on the MCP server or direct Figma API
   */
  async callTool(toolName, params) {
    if (!this.connected) {
      throw new Error('Not connected to Figma service');
    }

    if (process.env.ENABLE_LOGGING === 'true') {
      console.log(`🔧 Calling ${this.useDirectAPI ? 'Figma API' : 'MCP tool'}: ${toolName}`);
    }

    try {
      if (this.useDirectAPI) {
        return await this._callDirectAPI(toolName, params);
      } else {
        return await this._callMCPTool(toolName, params);
      }
    } catch (error) {
      console.error(`Error calling ${toolName}:`, error.message);
      
      // If MCP fails, try fallback to direct API
      if (!this.useDirectAPI && toolName === 'figma_get_file') {
        console.log('🔄 Falling back to direct Figma API...');
        this.useDirectAPI = true;
        return await this._callDirectAPI(toolName, params);
      }
      
      throw error;
    }
  }

  /**
   * Get a Figma file's design data
   */
  async getFile(fileKey, nodeId = null) {
    const params = { file_key: fileKey };
    if (nodeId) {
      params.node_id = nodeId;
    }

    return await this.callTool('figma_get_file', params);
  }

  /**
   * Get file nodes (specific sections of a design)
   */
  async getFileNodes(fileKey, nodeIds) {
    return await this.callTool('figma_get_file_nodes', {
      file_key: fileKey,
      ids: nodeIds
    });
  }

  /**
   * Get component information
   */
  async getComponent(fileKey, componentId) {
    return await this.callTool('figma_get_component', {
      file_key: fileKey,
      component_id: componentId
    });
  }

  /**
   * Get design styles (colors, text styles, etc.)
   */
  async getStyles(fileKey) {
    return await this.callTool('figma_get_styles', {
      file_key: fileKey
    });
  }

  /**
   * Search for files
   */
  async searchFiles(query) {
    return await this.callTool('figma_search_files', {
      query: query
    });
  }

  /**
   * Get user's recent files
   */
  async getRecentFiles() {
    return await this.callTool('figma_get_recent_files', {});
  }

  /**
   * Internal MCP server call or mock data
   */
  async _callMCPTool(method, params) {
    // Use mock data if in mock mode or if MCP is not available
    if (!this.useDirectAPI && (process.env.USE_MOCK_DATA === 'true' || !this.serverConfig.url)) {
      return this._getMockData(method, params);
    }

    const response = await fetch(`${this.serverConfig.url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: method,
        params: params
      }),
      timeout: this.serverConfig.timeout
    });

    if (!response.ok) {
      throw new Error(`MCP server error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    if (data.error) {
      throw new Error(`MCP error: ${data.error.message}`);
    }

    return data.result;
  }

  /**
   * Direct Figma API call (fallback)
   */
  async _callDirectAPI(toolName, params) {
    const token = process.env.FIGMA_ACCESS_TOKEN;
    if (!token) {
      throw new Error('FIGMA_ACCESS_TOKEN environment variable required for direct API access');
    }

    switch (toolName) {
      case 'figma_get_file':
        return await this._getFigmaFileDirect(params.file_key, params.node_id);
      case 'figma_get_styles':
        return await this._getFigmaStylesDirect(params.file_key);
      default:
        throw new Error(`Direct API does not support: ${toolName}`);
    }
  }

  /**
   * Direct Figma API file fetch
   */
  async _getFigmaFileDirect(fileKey, nodeId = null) {
    // URL-encode node ID if provided (Figma uses : which needs encoding)
    const encodedNodeId = nodeId ? encodeURIComponent(nodeId) : null;
    const url = encodedNodeId 
      ? `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodedNodeId}`
      : `https://api.figma.com/v1/files/${fileKey}`;

    console.log(`📡 Fetching from Figma API: ${url}`);

    const response = await fetch(url, {
      headers: {
        'X-Figma-Token': process.env.FIGMA_ACCESS_TOKEN
      },
      timeout: this.serverConfig.timeout
    });

    if (!response.ok) {
      throw new Error(`Figma API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    // Debug: Log what we actually get from Figma
    if (process.env.ENABLE_LOGGING === 'true') {
      console.log('🔍 Figma API response keys:', Object.keys(data));
      if (data.document) {
        console.log('📄 Document children count:', data.document.children?.length || 0);
      }
    }
    
    return data;
  }

  /**
   * Direct Figma API styles fetch
   */
  async _getFigmaStylesDirect(fileKey) {
    const response = await fetch(`https://api.figma.com/v1/files/${fileKey}/styles`, {
      headers: {
        'X-Figma-Token': process.env.FIGMA_ACCESS_TOKEN
      },
      timeout: this.serverConfig.timeout
    });

    if (!response.ok) {
      throw new Error(`Figma API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    // Debug: Log styles we found
    if (process.env.ENABLE_LOGGING === 'true') {
      console.log('🎨 Found styles:', data.meta?.styles?.length || 0);
      if (data.meta?.styles) {
        const styleTypes = {};
        data.meta.styles.forEach(style => {
          styleTypes[style.style_type] = (styleTypes[style.style_type] || 0) + 1;
        });
        console.log('📊 Style types:', styleTypes);
      }
    }
    
    return data;
  }

  /**
   * Get Figma components from the file
   */
  async _getFigmaComponentsDirect(fileKey) {
    const response = await fetch(`https://api.figma.com/v1/files/${fileKey}/components`, {
      headers: {
        'X-Figma-Token': process.env.FIGMA_ACCESS_TOKEN
      },
      timeout: this.serverConfig.timeout
    });

    if (!response.ok) {
      throw new Error(`Figma API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    // Debug: Log components we found
    if (process.env.ENABLE_LOGGING === 'true') {
      console.log('🧩 Found components:', data.meta?.components?.length || 0);
    }
    
    return data;
  }

  /**
   * Test MCP server connection
   */
  async _testMCPConnection() {
    try {
      const response = await fetch(`${this.serverConfig.url}/health`, {
        timeout: 5000
      });
      
      if (!response.ok) {
        throw new Error(`MCP server health check failed: ${response.status}`);
      }
    } catch (error) {
      if (error.code === 'ENOTFOUND' || error.message.includes('Only absolute URLs are supported')) {
        throw new Error('MCP server not available');
      }
      throw error;
    }
  }

  /**
   * Test direct Figma API connection
   */
  async _testDirectAPI() {
    const token = process.env.FIGMA_ACCESS_TOKEN;
    if (!token) {
      throw new Error('FIGMA_ACCESS_TOKEN environment variable required');
    }

    const response = await fetch('https://api.figma.com/v1/me', {
      headers: {
        'X-Figma-Token': token
      },
      timeout: 5000
    });

    if (!response.ok) {
      throw new Error(`Figma API authentication failed: ${response.status}`);
    }

    const user = await response.json();
    console.log(`👤 Connected as Figma user: ${user.email}`);
  }

  /**
   * Mock data for development/testing
   * Replace this with actual MCP calls
   */
  _getMockData(method, params) {
    switch (method) {
      case 'figma_get_file':
        return this._getMockFileData();
      
      case 'figma_get_styles':
        return this._getMockStylesData();
      
      default:
        return {};
    }
  }

  _getMockFileData() {
    return {
      name: "Design System",
      lastModified: new Date().toISOString(),
      document: {
        id: "0:0",
        name: "Document",
        type: "DOCUMENT",
        children: [
          {
            id: "1:1",
            name: "Page 1",
            type: "CANVAS",
            children: [
              {
                id: "2:1",
                name: "hero-section",
                type: "FRAME",
                visible: true,
                layoutMode: "VERTICAL",
                primaryAxisAlignItems: "CENTER",
                counterAxisAlignItems: "CENTER",
                itemSpacing: 24,
                paddingLeft: 40,
                paddingRight: 40,
                paddingTop: 60,
                paddingBottom: 60,
                absoluteBoundingBox: {
                  x: 0,
                  y: 0,
                  width: 1200,
                  height: 600
                },
                fills: [
                  {
                    type: "SOLID",
                    visible: true,
                    opacity: 1,
                    color: { r: 0.95, g: 0.95, b: 0.98 }
                  }
                ],
                children: [
                  {
                    id: "3:1",
                    name: "Headline",
                    type: "TEXT",
                    visible: true,
                    characters: "Welcome to Our Product",
                    style: {
                      fontFamily: "Inter",
                      fontSize: 48,
                      fontWeight: 700,
                      lineHeightPx: 56,
                      textAlignHorizontal: "CENTER"
                    },
                    fills: [
                      {
                        type: "SOLID",
                        color: { r: 0.1, g: 0.1, b: 0.15 }
                      }
                    ],
                    absoluteBoundingBox: {
                      width: 600,
                      height: 56
                    }
                  },
                  {
                    id: "3:2",
                    name: "Subheadline",
                    type: "TEXT",
                    visible: true,
                    characters: "Build amazing things with our platform",
                    style: {
                      fontFamily: "Inter",
                      fontSize: 20,
                      fontWeight: 400,
                      lineHeightPx: 28,
                      textAlignHorizontal: "CENTER"
                    },
                    fills: [
                      {
                        type: "SOLID",
                        color: { r: 0.4, g: 0.4, b: 0.5 }
                      }
                    ],
                    absoluteBoundingBox: {
                      width: 500,
                      height: 28
                    }
                  },
                  {
                    id: "3:3",
                    name: "cta-button",
                    type: "FRAME",
                    visible: true,
                    layoutMode: "HORIZONTAL",
                    primaryAxisAlignItems: "CENTER",
                    counterAxisAlignItems: "CENTER",
                    paddingLeft: 32,
                    paddingRight: 32,
                    paddingTop: 16,
                    paddingBottom: 16,
                    cornerRadius: 8,
                    fills: [
                      {
                        type: "SOLID",
                        color: { r: 0, g: 0.4, b: 1 }
                      }
                    ],
                    absoluteBoundingBox: {
                      width: 180,
                      height: 48
                    },
                    children: [
                      {
                        id: "4:1",
                        name: "Button Text",
                        type: "TEXT",
                        characters: "Get Started",
                        style: {
                          fontFamily: "Inter",
                          fontSize: 16,
                          fontWeight: 600
                        },
                        fills: [
                          {
                            type: "SOLID",
                            color: { r: 1, g: 1, b: 1 }
                          }
                        ]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      },
      styles: {
        fills: {
          "Primary": {
            color: { r: 0, g: 0.4, b: 1 },
            opacity: 1
          },
          "Background": {
            color: { r: 0.95, g: 0.95, b: 0.98 },
            opacity: 1
          }
        },
        text: {
          "Heading 1": {
            fontFamily: "Inter",
            fontSize: 48,
            fontWeight: 700
          },
          "Body": {
            fontFamily: "Inter",
            fontSize: 16,
            fontWeight: 400
          }
        }
      }
    };
  }

  _getMockStylesData() {
    return {
      fills: {},
      text: {},
      effects: {}
    };
  }

  /**
   * Disconnect from Figma service
   */
  async disconnect() {
    if (this.connected) {
      console.log('👋 Disconnecting from Figma service');
      this.connected = false;
      this.useDirectAPI = false;
    }
  }
}

module.exports = FigmaMCPClient;
