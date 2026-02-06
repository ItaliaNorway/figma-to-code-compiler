#!/usr/bin/env node

/**
 * Figma MCP Compiler Server
 * Express server with setup and compiler pages
 */

require('dotenv').config();

const express = require('express');
const { createServer } = require('http');
const CompilerEngine = require('./compiler-engine');
const { generateSetupPage } = require('./pages/setup');
const { generateCompilerPage } = require('./pages/compiler');

class FigmaCompilerServer {
  constructor() {
    this.app = express();
    this.server = null;
    this.compiler = new CompilerEngine();
    
    // State
    this.currentUrl = null;
    this.fileKey = null;
    this.nodeId = null;
    this.figmaData = null;
  }

  async start(port = 3000) {
    // Enable JSON body parsing
    this.app.use(express.json());

    // Setup page (landing page)
    this.app.get('/', (req, res) => {
      res.send(generateSetupPage());
    });

    // Validate token endpoint
    this.app.post('/api/validate-token', async (req, res) => {
      const { token } = req.body;
      
      if (!token) {
        return res.json({ valid: false, error: 'Token required' });
      }
      
      try {
        const response = await fetch('https://api.figma.com/v1/me', {
          headers: { 'X-Figma-Token': token }
        });
        
        if (response.ok) {
          const data = await response.json();
          res.json({ valid: true, user: data.handle || data.email });
        } else {
          res.json({ valid: false, error: 'Invalid token' });
        }
      } catch (err) {
        res.json({ valid: false, error: err.message });
      }
    });

    // Compiler page
    this.app.get('/compiler', (req, res) => {
      let renderedHTML = null;
      if (this.figmaData) {
        renderedHTML = this.compiler.compile(this.figmaData);
      }
      
      res.send(generateCompilerPage({
        renderedHTML,
        fileName: this.figmaData?.name || 'No file loaded',
        currentUrl: this.currentUrl || '',
        codeConnectMap: this.compiler.getCodeConnectMap()
      }));
    });

    // Compile endpoint
    this.app.post('/api/compile', async (req, res) => {
      try {
        const { url, token } = req.body;
        
        if (!url) {
          return res.status(400).json({ success: false, error: 'URL required' });
        }
        if (!token) {
          return res.status(400).json({ success: false, error: 'Token required' });
        }
        
        // Set the token for this request
        process.env.FIGMA_ACCESS_TOKEN = token;
        
        console.log('📂 Compile requested: ' + url);
        const parsed = this.compiler.parseFigmaUrl(url);
        this.fileKey = parsed.fileKey;
        this.nodeId = parsed.nodeId;
        this.currentUrl = url;
        
        this.figmaData = await this.compiler.fetchFigmaData(this.fileKey, this.nodeId);
        console.log('✅ Figma data compiled');
        
        res.json({ success: true, message: 'Compiled successfully', name: this.figmaData.name });
      } catch (err) {
        console.error('❌ Compile error:', err);
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Refresh endpoint
    this.app.post('/api/refresh', async (req, res) => {
      try {
        const { token } = req.body;
        
        if (!this.fileKey) {
          return res.status(400).json({ success: false, error: 'No design loaded' });
        }
        if (!token) {
          return res.status(400).json({ success: false, error: 'Token required' });
        }
        
        process.env.FIGMA_ACCESS_TOKEN = token;
        
        console.log('🔄 Refresh requested...');
        this.figmaData = await this.compiler.fetchFigmaData(this.fileKey, this.nodeId);
        console.log('✅ Figma data refreshed');
        
        res.json({ success: true, message: 'Refreshed successfully' });
      } catch (err) {
        console.error('❌ Refresh error:', err);
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Legacy endpoints for backward compatibility
    this.app.get('/refresh', async (req, res) => {
      if (!this.figmaData) {
        return res.status(400).json({ success: false, error: 'No design loaded' });
      }
      try {
        this.figmaData = await this.compiler.fetchFigmaData(this.fileKey, this.nodeId);
        res.json({ success: true, message: 'Figma data refreshed' });
      } catch (err) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    this.app.get('/load', async (req, res) => {
      try {
        const newUrl = req.query.url;
        if (!newUrl) {
          return res.status(400).json({ success: false, error: 'URL parameter required' });
        }
        
        const parsed = this.compiler.parseFigmaUrl(newUrl);
        this.fileKey = parsed.fileKey;
        this.nodeId = parsed.nodeId;
        this.currentUrl = newUrl;
        
        this.figmaData = await this.compiler.fetchFigmaData(this.fileKey, this.nodeId);
        res.json({ success: true, message: 'Figma data loaded', name: this.figmaData.name });
      } catch (err) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    this.server = createServer(this.app);
    this.server.listen(port, () => {
      console.log('🌐 Server running at http://localhost:' + port);
      console.log('📋 Open the URL to configure and start compiling');
    });
  }
}

// CLI usage
if (require.main === module) {
  const port = parseInt(process.argv[2]) || 3000;
  const server = new FigmaCompilerServer();
  server.start(port);
}

module.exports = FigmaCompilerServer;
