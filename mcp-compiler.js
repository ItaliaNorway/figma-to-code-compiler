#!/usr/bin/env node

// Load environment variables
require('dotenv').config();

const express = require('express');
const { createServer } = require('http');
const FigmaMCPClient = require('./mcp-client');

/**
 * Simple MCP-based Figma Compiler
 * Read Figma data via MCP, translate Auto Layout to CSS
 */

class MCPCompiler {
  constructor() {
    this.app = express();
    this.server = null;
    this.mcpClient = new FigmaMCPClient();
    this.imageUrls = {}; // Cache for image URLs from Figma API (fallback)
    this.svgContent = {}; // Cache for inline SVG content
    this.videoUrls = {}; // Cache for video URLs
    this.codeConnectMap = {}; // Cache for Code Connect mappings
    this.currentFileKey = null;
  }

  parseFigmaUrl(url) {
    if (!url || !url.includes('figma.com')) {
      throw new Error('Invalid Figma URL');
    }
    
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/');
    const fileKey = pathParts[2];
    const nodeIdParam = urlObj.searchParams.get('node-id');
    const nodeId = nodeIdParam ? nodeIdParam.replace('-', ':') : null;
    
    return { fileKey, nodeId };
  }

  async fetchFigmaData(fileKey, nodeId) {
    try {
      this.currentFileKey = fileKey;
      await this.mcpClient.connect();
      const figmaData = await this.mcpClient.getFile(fileKey, nodeId);
      
      // Fetch design system variables/tokens
      await this.fetchVariableDefinitions(fileKey, figmaData);
      
      // Fetch image URLs for vector/image nodes
      await this.fetchImageUrls(fileKey, figmaData);
      
      // Fetch Code Connect mappings for design system components
      await this.fetchCodeConnectMappings(fileKey, nodeId, figmaData);
      
      return figmaData;
    } catch (error) {
      console.error('❌ MCP Error:', error);
      throw error;
    }
  }
  
  async fetchCodeConnectMappings(fileKey, nodeId, figmaData) {
    const token = process.env.FIGMA_ACCESS_TOKEN;
    if (!token) return;
    
    this.codeConnectMap = {};
    
    // Extract the actual node to scan
    let nodeToScan = figmaData;
    if (figmaData.nodes) {
      const firstNodeKey = Object.keys(figmaData.nodes)[0];
      if (firstNodeKey) {
        nodeToScan = figmaData.nodes[firstNodeKey].document;
      }
    }
    
    // Collect all node IDs that might be component instances
    const componentNodeIds = [];
    this.collectComponentNodes(nodeToScan, componentNodeIds);
    
    if (componentNodeIds.length === 0) return;
    
    console.log(`🔗 Checking Code Connect for ${componentNodeIds.length} potential components...`);
    
    // Fetch Code Connect mappings via Figma API
    // The dev mode API endpoint for code connect
    try {
      for (const compNodeId of componentNodeIds) {
        try {
          const response = await fetch(
            `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(compNodeId)}&plugin_data=shared`,
            { headers: { 'X-Figma-Token': token } }
          );
          
          if (response.ok) {
            const data = await response.json();
            const nodeData = data.nodes?.[compNodeId]?.document;
            
            if (nodeData) {
              // Check if this is a component instance with Code Connect
              const componentId = nodeData.componentId;
              const mainComponentId = nodeData.mainComponent?.id;
              
              // Store component info for React generation
              if (componentId || mainComponentId) {
                // Extract component name from node name or component set
                const componentName = this.extractComponentName(nodeData);
                const props = this.extractComponentProps(nodeData);
                
                if (componentName) {
                  this.codeConnectMap[compNodeId] = {
                    componentName,
                    props,
                    source: nodeData.componentProperties ? 'design-system' : 'local',
                    nodeData
                  };
                  console.log(`  ✅ Found component: ${componentName} (${compNodeId})`);
                }
              }
            }
          }
        } catch (err) {
          // Silently skip individual node errors
        }
      }
    } catch (error) {
      console.warn('⚠️  Error fetching Code Connect mappings:', error.message);
    }
    
    console.log(`🔗 Found ${Object.keys(this.codeConnectMap).length} Code Connect components`);
  }
  
  collectComponentNodes(node, componentNodeIds, depth = 0) {
    if (!node) return;
    if (node.visible === false) return;
    
    // Check if this is a component instance
    if (node.type === 'INSTANCE' || node.componentId) {
      componentNodeIds.push(node.id);
    }
    
    // Recurse into children
    if (node.children && Array.isArray(node.children)) {
      for (const child of node.children) {
        this.collectComponentNodes(child, componentNodeIds, depth + 1);
      }
    }
  }
  
  extractComponentName(nodeData) {
    // Try to get component name from various sources
    if (nodeData.name) {
      // Clean up the name - remove variant info like "Size=Large, State=Default"
      let name = nodeData.name.split(',')[0].trim();
      // Convert to PascalCase for React component
      name = name.replace(/[^a-zA-Z0-9]/g, ' ')
                 .split(' ')
                 .filter(Boolean)
                 .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
                 .join('');
      return name;
    }
    return null;
  }
  
  extractComponentProps(nodeData) {
    const props = {};
    
    // Extract from componentProperties (variant properties)
    if (nodeData.componentProperties) {
      for (const [key, value] of Object.entries(nodeData.componentProperties)) {
        // Clean up property name
        const propName = key.replace(/#.*$/, '').toLowerCase();
        props[propName] = value.value || value;
      }
    }
    
    // Also check for overrides that might indicate prop values
    if (nodeData.overrides) {
      for (const override of nodeData.overrides) {
        if (override.overriddenFields?.includes('characters')) {
          props.children = override.characters;
        }
      }
    }
    
    return props;
  }
  
  getCodeConnectComponent(nodeId) {
    return this.codeConnectMap[nodeId] || null;
  }
  
  async fetchVariableDefinitions(fileKey, figmaData) {
    this.variableDefs = {};
    
    // Extract the actual node to scan
    let nodeToScan = figmaData;
    if (figmaData.nodes) {
      const firstNodeKey = Object.keys(figmaData.nodes)[0];
      if (firstNodeKey) {
        nodeToScan = figmaData.nodes[firstNodeKey].document;
      }
    }
    
    // Collect all bound variable IDs from the node tree
    const boundVarIds = new Set();
    this.collectBoundVariables(nodeToScan, boundVarIds);
    
    if (boundVarIds.size === 0) {
      console.log('🎨 No bound variables found in design');
      return;
    }
    
    console.log(`🎨 Found ${boundVarIds.size} bound variables, fetching definitions...`);
    
    // Try to get variable definitions via MCP
    try {
      const varDefs = await this.mcpClient.getVariableDefinitions(fileKey, nodeToScan.id || '0:0');
      if (varDefs && Object.keys(varDefs).length > 0) {
        // Map variable names to CSS variable names
        for (const [varName, varValue] of Object.entries(varDefs)) {
          // Skip composite types like Font()
          if (typeof varValue === 'string' && varValue.startsWith('Font(')) continue;
          
          const cssVarName = '--' + varName.replace(/\//g, '-').replace(/\s+/g, '-').toLowerCase();
          
          // Store by name for lookup
          this.variableDefs[varName] = {
            name: varName,
            cssVar: cssVarName,
            value: varValue
          };
        }
        console.log(`🎨 Loaded ${Object.keys(this.variableDefs).length} design tokens via MCP`);
      }
    } catch (error) {
      console.warn('⚠️  Could not fetch variable definitions via MCP:', error.message);
    }
  }
  
  collectBoundVariables(node, boundVarIds) {
    if (!node) return;
    
    // Check boundVariables on this node
    if (node.boundVariables) {
      for (const [prop, binding] of Object.entries(node.boundVariables)) {
        if (Array.isArray(binding)) {
          binding.forEach(b => b.id && boundVarIds.add(b.id));
        } else if (binding.id) {
          boundVarIds.add(binding.id);
        }
      }
    }
    
    // Check fills for bound variables
    if (node.fills) {
      node.fills.forEach(fill => {
        if (fill.boundVariables?.color?.id) {
          boundVarIds.add(fill.boundVariables.color.id);
        }
      });
    }
    
    // Recurse into children
    if (node.children) {
      node.children.forEach(child => this.collectBoundVariables(child, boundVarIds));
    }
  }
  
  figmaColorToCSS(color) {
    if (!color) return null;
    const r = Math.round((color.r || 0) * 255);
    const g = Math.round((color.g || 0) * 255);
    const b = Math.round((color.b || 0) * 255);
    const a = color.a !== undefined ? color.a : 1;
    if (a === 1) {
      return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase();
    }
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  
  // Get CSS var() syntax for a bound variable
  getVariableCSS(boundVariable, fallbackValue) {
    if (!boundVariable || !this.variableDefs) return fallbackValue;
    
    const varId = boundVariable.id;
    const varDef = this.variableDefs[varId];
    
    if (varDef) {
      return `var(${varDef.cssVar}, ${fallbackValue})`;
    }
    return fallbackValue;
  }
  
  // Check if a node has bound variables and return CSS with var() syntax
  getBoundVariableValue(node, property, fallbackValue) {
    if (!node.boundVariables || !node.boundVariables[property]) {
      return fallbackValue;
    }
    
    const binding = node.boundVariables[property];
    // Handle array bindings (like fills, fontFamily, fontSize)
    if (Array.isArray(binding)) {
      if (binding.length > 0 && binding[0].id) {
        return this.getVariableCSSFromId(binding[0].id, property, fallbackValue);
      }
    } else if (binding.id) {
      return this.getVariableCSSFromId(binding.id, property, fallbackValue);
    }
    
    return fallbackValue;
  }
  
  // Map variable ID to CSS var() syntax based on property type
  getVariableCSSFromId(varId, property, fallbackValue) {
    // Extract the variable name hint from the ID
    // Format: VariableID:hash/nodeId
    // We map based on property type to common design system patterns
    
    const propertyToVarMap = {
      'fills': 'color/neutral/text-default',
      'fontFamily': 'font-family',
      'fontSize': 'font-size/10',
      'fontStyle': 'font-weight/bold'
    };
    
    const varName = propertyToVarMap[property];
    if (varName && this.variableDefs[varName]) {
      const varDef = this.variableDefs[varName];
      return `var(${varDef.cssVar}, ${fallbackValue})`;
    }
    
    // If we have the variable definition loaded, use it
    if (this.variableDefs) {
      for (const [name, def] of Object.entries(this.variableDefs)) {
        if (def.cssVar) {
          // Match based on property type
          if (property === 'fills' && name.includes('color')) {
            return `var(${def.cssVar}, ${fallbackValue})`;
          }
          if (property === 'fontFamily' && name.includes('font-family')) {
            return `var(${def.cssVar}, ${fallbackValue})`;
          }
          if (property === 'fontSize' && name.includes('font-size')) {
            return `var(${def.cssVar}, ${fallbackValue})`;
          }
        }
      }
    }
    
    return fallbackValue;
  }
  
  async fetchImageUrls(fileKey, figmaData) {
    // Extract the actual node to scan (same logic as generateHTML)
    let nodeToScan = figmaData;
    if (figmaData.nodes) {
      const firstNodeKey = Object.keys(figmaData.nodes)[0];
      if (firstNodeKey) {
        nodeToScan = figmaData.nodes[firstNodeKey].document;
      }
    }
    
    // Collect vector nodes, image fill nodes, and video fill nodes separately
    const vectorNodeIds = [];
    const imageNodeIds = [];
    const videoNodes = [];
    console.log('🔍 Scanning for image/vector/video nodes...');
    this.collectImageNodes(nodeToScan, vectorNodeIds, imageNodeIds, videoNodes);
    
    const token = process.env.FIGMA_ACCESS_TOKEN;
    if (!token) {
      console.warn('⚠️  No FIGMA_ACCESS_TOKEN - images will not be rendered');
      return;
    }
    
    this.svgContent = {};
    this.imageUrls = {};
    this.videoUrls = {};
    
    // Fetch SVGs for vector nodes
    if (vectorNodeIds.length > 0) {
      console.log(`🖼️  Fetching SVG for ${vectorNodeIds.length} vector nodes...`);
      try {
        const ids = vectorNodeIds.join(',');
        const response = await fetch(
          `https://api.figma.com/v1/images/${fileKey}?ids=${ids}&format=svg`,
          { headers: { 'X-Figma-Token': token } }
        );
        
        if (response.ok) {
          const data = await response.json();
          const svgUrls = data.images || {};
          
          for (const [nodeId, url] of Object.entries(svgUrls)) {
            if (url) {
              try {
                const svgResponse = await fetch(url);
                if (svgResponse.ok) {
                  const svgText = await svgResponse.text();
                  this.svgContent[nodeId] = svgText;
                  console.log(`  ✅ Fetched SVG for ${nodeId}`);
                }
              } catch (err) {
                console.warn(`  ⚠️  Failed to fetch SVG for ${nodeId}:`, err.message);
              }
            }
          }
        }
      } catch (error) {
        console.warn('⚠️  Error fetching SVG URLs:', error.message);
      }
    }
    
    // First, fetch the file's images/assets to check for videos
    let fileAssets = {};
    try {
      const assetsResponse = await fetch(
        `https://api.figma.com/v1/files/${fileKey}/images`,
        { headers: { 'X-Figma-Token': token } }
      );
      if (assetsResponse.ok) {
        const assetsData = await assetsResponse.json();
        fileAssets = assetsData.meta?.images || {};
        console.log(`📦 Found ${Object.keys(fileAssets).length} file assets`);
        // Log a few asset URLs to see their format
        const assetEntries = Object.entries(fileAssets).slice(0, 3);
        for (const [ref, url] of assetEntries) {
          console.log(`   Asset ${ref.substring(0, 8)}...: ${url.substring(0, 80)}...`);
        }
      }
    } catch (error) {
      console.warn('⚠️  Error fetching file assets:', error.message);
    }
    
    // Fetch PNG for image fill nodes
    if (imageNodeIds.length > 0) {
      console.log(`🖼️  Fetching PNG for ${imageNodeIds.length} image nodes...`);
      try {
        const ids = imageNodeIds.join(',');
        const response = await fetch(
          `https://api.figma.com/v1/images/${fileKey}?ids=${ids}&format=png&scale=2`,
          { headers: { 'X-Figma-Token': token } }
        );
        
        if (response.ok) {
          const data = await response.json();
          const imageUrls = data.images || {};
          
          for (const [nodeId, url] of Object.entries(imageUrls)) {
            if (url) {
              const nodeInfo = this.findNodeById(nodeToScan, nodeId);
              const nodeName = nodeInfo?.name?.toLowerCase() || '';
              
              // Check if this is a GIF (by name or file extension)
              const isGifNode = nodeName.includes('.gif') || nodeName.includes('gif');
              
              // Check if this is a video (by name)
              const isVideoNode = !isGifNode && (
                nodeName.includes('video') ||
                nodeName.includes('.mp4') ||
                nodeName.includes('.webm') ||
                nodeName.includes('.mov')
              );
              
              // Get the original asset URL from file assets (preserves GIF format)
              const imageFill = nodeInfo?.fills?.find(f => f.type === 'IMAGE' && f.visible !== false);
              const originalAssetUrl = imageFill?.imageRef ? fileAssets[imageFill.imageRef] : null;
              
              if (isGifNode) {
                // For GIFs, use the original asset URL if available (preserves animation)
                // Otherwise fall back to the rendered PNG
                this.gifUrls = this.gifUrls || {};
                this.gifUrls[nodeId] = originalAssetUrl || url;
                console.log(`  🎞️  Detected GIF node: ${nodeId}${originalAssetUrl ? ' (using original asset)' : ' (using rendered image)'}`);
              } else if (isVideoNode) {
                // For video nodes, store thumbnail
                this.videoUrls[nodeId] = url;
                console.log(`  🎬 Detected video node: ${nodeId} (using thumbnail)`);
              } else {
                this.imageUrls[nodeId] = url;
                console.log(`  ✅ Got image URL for ${nodeId}`);
              }
            }
          }
        }
      } catch (error) {
        console.warn('⚠️  Error fetching image URLs:', error.message);
      }
    }
    
    // Process explicit video nodes (if any were detected with VIDEO fill type)
    if (videoNodes.length > 0) {
      console.log(`🎬 Processing ${videoNodes.length} video nodes...`);
      for (const { id, node } of videoNodes) {
        const videoFill = node.fills?.find(f => f.type === 'VIDEO' && f.visible !== false);
        if (videoFill?.videoRef && fileAssets[videoFill.videoRef]) {
          this.videoUrls[id] = fileAssets[videoFill.videoRef];
          console.log(`  ✅ Got video URL for ${id}`);
        }
      }
    }
    
    console.log(`✅ Fetched ${Object.keys(this.svgContent).length} inline SVGs, ${Object.keys(this.imageUrls).length} image URLs, ${Object.keys(this.videoUrls).length} video URLs`);
  }
  
  collectImageNodes(node, vectorIds, imageIds, videoIds, depth = 0) {
    if (!node) return;
    
    // Skip hidden nodes
    if (node.visible === false) return;
    
    // Vector types that need SVG rendering
    const vectorTypes = ['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'REGULAR_POLYGON', 'SLICE'];
    
    if (vectorTypes.includes(node.type)) {
      vectorIds.push(node.id);
      console.log(`  📷 Found ${node.type}: ${node.name} (${node.id})`);
    }
    
    // Check for image and video fills
    if (node.fills && Array.isArray(node.fills)) {
      const imageFill = node.fills.find(f => f.type === 'IMAGE' && f.visible !== false);
      const videoFill = node.fills.find(f => f.type === 'VIDEO' && f.visible !== false);
      
      if (videoFill) {
        videoIds.push({ id: node.id, node });
        console.log(`  🎬 Found VIDEO fill: ${node.name} (${node.id})`);
        if (videoFill.videoRef) console.log(`     videoRef: ${videoFill.videoRef}`);
      } else if (imageFill) {
        imageIds.push(node.id);
        console.log(`  🖼️  Found IMAGE fill: ${node.name} (${node.id})`);
        // Check if this might be a video (name contains video/mp4)
        if (node.name.toLowerCase().includes('video') || node.name.toLowerCase().includes('.mp4')) {
          console.log(`     ⚠️  Note: This node is named like a video but has IMAGE fill type`);
        }
      }
    }
    
    // Recurse into children
    if (node.children && Array.isArray(node.children)) {
      node.children.forEach(child => this.collectImageNodes(child, vectorIds, imageIds, videoIds, depth + 1));
    }
  }
  
  getImageUrl(nodeId) {
    return this.imageUrls[nodeId] || null;
  }
  
  getSvgContent(nodeId) {
    return this.svgContent[nodeId] || null;
  }
  
  getVideoUrl(nodeId) {
    return this.videoUrls[nodeId] || null;
  }
  
  getGifUrl(nodeId) {
    return this.gifUrls?.[nodeId] || null;
  }
  
  hasVideoFill(node) {
    // Check for explicit VIDEO fill or if we have a video URL for this node
    return node.fills?.some(f => f.type === 'VIDEO' && f.visible !== false) || 
           this.videoUrls[node.id] !== undefined;
  }
  
  hasGifFill(node) {
    // Check if we have a GIF URL for this node
    return this.gifUrls?.[node.id] !== undefined;
  }
  
  // Extract Lottie URL from node name
  // Supported formats:
  // - Direct JSON: https://assets.lottiefiles.com/packages/xxx.json
  // - Direct lottie: https://lottie.host/xxx/xxx.lottie or https://lottie.host/xxx/xxx.json
  // - App URL (will show placeholder): https://app.lottiefiles.com/animation/xxx
  getLottieUrl(node) {
    if (!node.name) return null;
    
    // Match direct JSON/lottie URLs (these work directly)
    const directMatch = node.name.match(/https:\/\/(?:assets\d*\.lottiefiles\.com|lottie\.host)\/[^\s]+\.(?:json|lottie)/i);
    if (directMatch) return directMatch[0];
    
    // Match app.lottiefiles.com URLs (need to be converted manually by user)
    const appMatch = node.name.match(/https:\/\/app\.lottiefiles\.com\/[^\s]+/i);
    if (appMatch) {
      // Return the app URL - user needs to get the actual JSON URL from LottieFiles
      console.log(`  ⚠️  Lottie app URL detected. For animation to work, use the direct JSON/lottie URL from LottieFiles.`);
      return appMatch[0];
    }
    
    return null;
  }
  
  hasLottieFill(node) {
    return this.getLottieUrl(node) !== null;
  }
  
  isDirectLottieUrl(url) {
    return url && (url.endsWith('.json') || url.endsWith('.lottie'));
  }
  
  findNodeById(rootNode, nodeId) {
    if (!rootNode) return null;
    if (rootNode.id === nodeId) return rootNode;
    
    if (rootNode.children && Array.isArray(rootNode.children)) {
      for (const child of rootNode.children) {
        const found = this.findNodeById(child, nodeId);
        if (found) return found;
      }
    }
    return null;
  }
  
  processSvg(svgCode, className, nodeId, node) {
    // Get sizing from Figma design
    const bbox = node.absoluteBoundingBox;
    const sizingH = node.layoutSizingHorizontal || 'FIXED';
    const sizingV = node.layoutSizingVertical || 'FIXED';
    
    let widthAttr, heightAttr;
    let styleAttr = '';
    
    // Width
    if (sizingH === 'FILL') {
      widthAttr = '100%';
      styleAttr += 'flex: 1; ';
    } else if (sizingH === 'HUG') {
      // Keep original width from SVG
      widthAttr = null;
    } else if (bbox) {
      // FIXED - use exact Figma dimensions
      widthAttr = `${this.round(bbox.width)}`;
    }
    
    // Height
    if (sizingV === 'FILL') {
      heightAttr = '100%';
      styleAttr += 'flex-grow: 1; ';
    } else if (sizingV === 'HUG') {
      // Keep original height from SVG
      heightAttr = null;
    } else if (bbox) {
      // FIXED - use exact Figma dimensions
      heightAttr = `${this.round(bbox.height)}`;
    }
    
    // Add class and data-figma-id to the SVG element
    let processed = svgCode.replace(/<svg/, `<svg class="${className}" data-figma-id="${nodeId}"`);
    
    // Replace width/height attributes based on sizing mode
    if (widthAttr !== null) {
      processed = processed.replace(/width="[^"]*"/, `width="${widthAttr}"`);
    }
    if (heightAttr !== null) {
      processed = processed.replace(/height="[^"]*"/, `height="${heightAttr}"`);
    }
    
    // Add style attribute if needed
    if (styleAttr) {
      processed = processed.replace(/<svg([^>]*)>/, `<svg$1 style="${styleAttr.trim()}">`);
    }
    
    return processed;
  }

  getClassName(name) {
    return name ? name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') : 'unnamed';
  }
  
  // Round to 1 decimal place
  round(value) {
    return Math.round(value * 10) / 10;
  }

  applyGradient(fill) {
    if (!fill.gradientHandlePositions || fill.gradientHandlePositions.length < 2) {
      return '';
    }
    const [start, end] = fill.gradientHandlePositions;
    // Convert Figma gradient angle to CSS angle
    // Figma uses handle positions where atan2 gives mathematical angle (0 = right, counterclockwise)
    // CSS linear-gradient: 0deg = bottom to top, 90deg = left to right, 180deg = top to bottom
    const mathAngle = Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI;
    const linearAngle = Math.round(90 + mathAngle);
    
    // Build color stops
    const stops = fill.gradientStops?.map(stop => {
      const r = Math.round(stop.color.r * 255);
      const g = Math.round(stop.color.g * 255);
      const b = Math.round(stop.color.b * 255);
      const a = stop.color.a ?? 1;
      return `rgba(${r}, ${g}, ${b}, ${a}) ${Math.round(stop.position * 100)}%`;
    }).join(', ');
    
    // Build angular stops (for conic-gradient, positions are in degrees 0-360)
    const angularStops = fill.gradientStops?.map(stop => {
      const r = Math.round(stop.color.r * 255);
      const g = Math.round(stop.color.g * 255);
      const b = Math.round(stop.color.b * 255);
      const a = stop.color.a ?? 1;
      return `rgba(${r}, ${g}, ${b}, ${a}) ${Math.round(stop.position * 360)}deg`;
    }).join(', ');
    
    switch (fill.type) {
      case 'GRADIENT_LINEAR':
        return `linear-gradient(${linearAngle}deg, ${stops})`;
      
      case 'GRADIENT_RADIAL':
        return `radial-gradient(circle, ${stops})`;
      
      case 'GRADIENT_ANGULAR':
        // Conic gradient - calculate starting angle from handle positions
        // CSS conic-gradient: 0deg = top, goes clockwise
        const conicAngle = Math.round(mathAngle + 90);
        return `conic-gradient(from ${conicAngle}deg at 50% 50%, ${angularStops})`;
      
      case 'GRADIENT_DIAMOND':
        // Diamond gradient - CSS doesn't have native diamond gradient
        // Approximate with 4 linear gradients in each quadrant
        const firstStop = fill.gradientStops?.[0];
        const lastStop = fill.gradientStops?.[fill.gradientStops.length - 1];
        if (firstStop && lastStop) {
          const r1 = Math.round(firstStop.color.r * 255);
          const g1 = Math.round(firstStop.color.g * 255);
          const b1 = Math.round(firstStop.color.b * 255);
          const a1 = firstStop.color.a ?? 1;
          const r2 = Math.round(lastStop.color.r * 255);
          const g2 = Math.round(lastStop.color.g * 255);
          const b2 = Math.round(lastStop.color.b * 255);
          const a2 = lastStop.color.a ?? 1;
          const c1 = `rgba(${r1}, ${g1}, ${b1}, ${a1})`;
          const c2 = `rgba(${r2}, ${g2}, ${b2}, ${a2})`;
          return `linear-gradient(to bottom right, ${c1} 0%, ${c2} 50%) bottom right / 50% 50% no-repeat, ` +
                 `linear-gradient(to bottom left, ${c1} 0%, ${c2} 50%) bottom left / 50% 50% no-repeat, ` +
                 `linear-gradient(to top left, ${c1} 0%, ${c2} 50%) top left / 50% 50% no-repeat, ` +
                 `linear-gradient(to top right, ${c1} 0%, ${c2} 50%) top right / 50% 50% no-repeat`;
        }
        return '';
      
      default:
        return '';
    }
  }

  applyEffect(effect) {
    switch (effect.type) {
      case 'DROP_SHADOW':
        return `box-shadow: ${effect.offset.x}px ${effect.offset.y}px ${effect.radius}px rgba(${Math.round(effect.color.r * 255)}, ${Math.round(effect.color.g * 255)}, ${Math.round(effect.color.b * 255)}, ${effect.color.a ?? 1});`;
      case 'INNER_SHADOW':
        return `box-shadow: inset ${effect.offset.x}px ${effect.offset.y}px ${effect.radius}px rgba(${Math.round(effect.color.r * 255)}, ${Math.round(effect.color.g * 255)}, ${Math.round(effect.color.b * 255)}, ${effect.color.a ?? 1});`;
      case 'LAYER_BLUR':
        return `filter: blur(${effect.radius}px);`;
      default:
        return '';
    }
  }

  translateAutoLayoutToCSS(node) {
    const styles = [];
    
    // Sizing based on Figma's layoutSizingHorizontal/Vertical properties:
    // - FIXED = fixed dimensions from bounding box
    // - HUG = auto-size to content (don't set dimension)
    // - FILL = flex: 1 to fill available space
    const bbox = node.absoluteBoundingBox;
    const sizingH = node.layoutSizingHorizontal || 'FIXED';
    const sizingV = node.layoutSizingVertical || 'FIXED';
    
    // Width
    if (sizingH === 'FILL') {
      styles.push('flex: 1');
      styles.push('align-self: stretch');
    } else if (sizingH === 'HUG') {
      // Don't set width - let content determine it
    } else if (bbox) {
      // FIXED
      styles.push(`width: ${this.round(bbox.width)}px`);
    }
    
    // Height
    if (sizingV === 'FILL') {
      styles.push('flex-grow: 1');
    } else if (sizingV === 'HUG') {
      // Don't set height - let content determine it
    } else if (bbox) {
      // FIXED
      styles.push(`height: ${this.round(bbox.height)}px`);
    }
    
    // Min/Max constraints
    if (node.minWidth !== undefined && node.minWidth > 0) styles.push(`min-width: ${this.round(node.minWidth)}px`);
    if (node.maxWidth !== undefined && node.maxWidth < 10000) styles.push(`max-width: ${this.round(node.maxWidth)}px`);
    if (node.minHeight !== undefined && node.minHeight > 0) styles.push(`min-height: ${this.round(node.minHeight)}px`);
    if (node.maxHeight !== undefined && node.maxHeight < 10000) styles.push(`max-height: ${this.round(node.maxHeight)}px`);
    
    // Background - support solid, gradient, and backgroundColor
    this.applyFillStyles(node, styles);
    if (!node.fills?.length && node.backgroundColor) {
      const r = Math.round(node.backgroundColor.r * 255);
      const g = Math.round(node.backgroundColor.g * 255);
      const b = Math.round(node.backgroundColor.b * 255);
      const a = node.backgroundColor.a ?? 1;
      styles.push(`background-color: rgba(${r}, ${g}, ${b}, ${a})`);
    }
    
    if (node.layoutMode) {
      styles.push('display: flex');
      styles.push(`flex-direction: ${node.layoutMode === 'VERTICAL' ? 'column' : 'row'}`);
      
      // Primary axis alignment
      if (node.primaryAxisAlignItems) {
        let justifyContent = node.primaryAxisAlignItems;
        // If SPACE_BETWEEN but only 1 child, use center instead (common Figma pattern)
        if (justifyContent === 'SPACE_BETWEEN' && node.children && node.children.length === 1) {
          justifyContent = 'CENTER';
        }
        const alignMap = { 'MIN': 'flex-start', 'CENTER': 'center', 'MAX': 'flex-end', 'SPACE_BETWEEN': 'space-between' };
        styles.push(`justify-content: ${alignMap[justifyContent] || 'flex-start'}`);
      }
      
      // Counter axis alignment
      if (node.counterAxisAlignItems) {
        const alignMap = { 'MIN': 'flex-start', 'CENTER': 'center', 'MAX': 'flex-end', 'BASELINE': 'baseline' };
        styles.push(`align-items: ${alignMap[node.counterAxisAlignItems] || 'stretch'}`);
      }
      
      // Gap between items
      if (node.itemSpacing !== undefined) styles.push(`gap: ${node.itemSpacing}px`);
      
      // Padding
      const pt = node.paddingTop || 0;
      const pr = node.paddingRight || 0;
      const pb = node.paddingBottom || 0;
      const pl = node.paddingLeft || 0;
      if (pt || pr || pb || pl) styles.push(`padding: ${pt}px ${pr}px ${pb}px ${pl}px`);
    }
    
    // Effects (shadows, blurs)
    if (node.effects && node.effects.length > 0) {
      const effectCSS = node.effects.map(e => this.applyEffect(e)).filter(Boolean);
      styles.push(...effectCSS);
    }
    
    return styles.join('; ');
  }

  translateNodeToHTML(node, depth = 0, parentHasAutoLayout = false) {
    if (!node) return '';
    
    // Skip hidden layers (visible: false in Figma)
    if (node.visible === false) return '';
    
    const indent = '  '.repeat(depth);
    const className = this.getClassName(node.name);
    const nodeHasAutoLayout = !!node.layoutMode;
    let html = '';
    
    switch (node.type) {
      case 'FRAME':
        // Check if this frame has a Lottie animation URL in its name
        if (this.hasLottieFill(node)) {
          const lottieUrl = this.getLottieUrl(node);
          const lottieStyle = this.translateVideoStyle(node, parentHasAutoLayout);
          console.log(`  🎭 Rendering Lottie: ${lottieUrl}`);
          
          if (this.isDirectLottieUrl(lottieUrl)) {
            // Direct JSON/lottie URL - use dotlottie-wc player
            html = `${indent}<dotlottie-wc class="${className}" data-figma-id="${node.id}" src="${lottieUrl}" speed="1" style="${lottieStyle}" loop autoplay></dotlottie-wc>`;
          } else {
            // App URL - show placeholder with instructions
            html = `${indent}<div class="${className} lottie-placeholder" data-figma-id="${node.id}" data-lottie-app-url="${lottieUrl}" style="${lottieStyle}; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); display: flex; align-items: center; justify-content: center; position: relative;">
${indent}  <div style="text-align: center; color: white; font-size: 12px; padding: 8px;">
${indent}    <div style="font-size: 24px; margin-bottom: 4px;">🎬</div>
${indent}    <div>Lottie Animation</div>
${indent}    <div style="font-size: 10px; opacity: 0.8;">Use direct .json/.lottie URL</div>
${indent}  </div>
${indent}</div>`;
          }
        } else {
          const frameStyle = this.translateAutoLayoutToCSS(node);
          const children = node.children ? 
            node.children.map(child => this.translateNodeToHTML(child, depth + 1, nodeHasAutoLayout)).join('\n') : '';
          
          html = `${indent}<div class="${className}" data-figma-id="${node.id}" style="${frameStyle}">
${children}
${indent}</div>`;
        }
        break;
        
      case 'RECTANGLE':
        // Check if this rectangle has a Lottie animation URL in its name
        if (this.hasLottieFill(node)) {
          const lottieUrl = this.getLottieUrl(node);
          const lottieStyle = this.translateVideoStyle(node, parentHasAutoLayout);
          console.log(`  🎭 Rendering Lottie: ${lottieUrl}`);
          
          if (this.isDirectLottieUrl(lottieUrl)) {
            html = `${indent}<dotlottie-wc class="${className}" data-figma-id="${node.id}" src="${lottieUrl}" speed="1" style="${lottieStyle}" loop autoplay></dotlottie-wc>`;
          } else {
            html = `${indent}<div class="${className} lottie-placeholder" data-figma-id="${node.id}" data-lottie-app-url="${lottieUrl}" style="${lottieStyle}; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); display: flex; align-items: center; justify-content: center;">
${indent}  <div style="text-align: center; color: white; font-size: 12px; padding: 8px;">
${indent}    <div style="font-size: 24px; margin-bottom: 4px;">🎬</div>
${indent}    <div>Lottie</div>
${indent}  </div>
${indent}</div>`;
          }
        }
        // Check if this rectangle has a GIF fill
        else if (this.hasGifFill(node)) {
          const gifUrl = this.getGifUrl(node.id);
          const gifStyle = this.translateVideoStyle(node, parentHasAutoLayout);
          // Note: Figma API returns static image, not animated GIF
          // To use animated GIF, provide external URL via data-gif-src attribute
          html = `${indent}<div class="${className} gif-container" data-figma-id="${node.id}" data-gif-name="${node.name}" style="${gifStyle}; background-image: url('${gifUrl}'); background-size: cover; background-position: center; position: relative;">
${indent}  <div style="position: absolute; bottom: 4px; right: 4px; padding: 2px 6px; background: rgba(0,0,0,0.6); border-radius: 4px; font-size: 10px; color: white;">GIF</div>
${indent}</div>`;
        }
        // Check if this rectangle has a video fill
        else if (this.hasVideoFill(node)) {
          const videoUrl = this.getVideoUrl(node.id);
          const videoStyle = this.translateVideoStyle(node, parentHasAutoLayout);
          // Render as a video container with poster/thumbnail
          html = `${indent}<div class="${className} video-container" data-figma-id="${node.id}" data-video-name="${node.name}" style="${videoStyle}; background-image: url('${videoUrl}'); background-size: cover; background-position: center; position: relative;">
${indent}  <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 48px; height: 48px; background: rgba(0,0,0,0.6); border-radius: 50%; display: flex; align-items: center; justify-content: center;">
${indent}    <svg width="24" height="24" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
${indent}  </div>
${indent}</div>`;
        } else {
          // Check for IMAGE fill - render as <img> if we have a URL
          const hasImageFill = node.fills && node.fills.some(f => f.type === 'IMAGE' && f.visible !== false);
          const imageUrl = this.getImageUrl(node.id);
          if (hasImageFill && imageUrl) {
            const imgStyles = [];
            const sizingH = node.layoutSizingHorizontal || 'FIXED';
            const sizingV = node.layoutSizingVertical || 'FIXED';
            const bbox = node.absoluteBoundingBox;
            if (sizingH === 'FILL') {
              imgStyles.push('width: 100%');
            } else if (bbox) {
              imgStyles.push(`width: ${this.round(bbox.width)}px`);
            }
            if (sizingV === 'FILL') {
              imgStyles.push('height: 100%');
            } else if (bbox) {
              imgStyles.push(`height: ${this.round(bbox.height)}px`);
            }
            imgStyles.push('object-fit: cover');
            imgStyles.push('display: block');
            if (node.cornerRadius) {
              imgStyles.push(`border-radius: ${this.round(node.cornerRadius)}px`);
            }
            html = `${indent}<img class="${className}" data-figma-id="${node.id}" src="${imageUrl}" alt="${node.name}" style="${imgStyles.join('; ')}" />`;
          } else {
            const rectStyle = this.translateRectangleStyle(node, parentHasAutoLayout);
            html = `${indent}<div class="${className}" data-figma-id="${node.id}" style="${rectStyle}"></div>`;
          }
        }
        break;
        
      case 'TEXT':
        const textStyle = this.translateTextStyle(node, parentHasAutoLayout);
        const textTag = this.getTextTag(node);
        html = `${indent}<${textTag} class="${className}" data-figma-id="${node.id}" style="${textStyle}">${node.characters || ''}</${textTag}>`;
        break;
        
      case 'GROUP':
        const groupChildren = node.children ? 
          node.children.map(child => this.translateNodeToHTML(child, depth + 1, parentHasAutoLayout)).join('\n') : '';
        html = `${indent}<div class="${className}" data-figma-id="${node.id}">
${groupChildren}
${indent}</div>`;
        break;
      
      case 'ELLIPSE':
        // Render ellipse as CSS (border-radius: 50%)
        const ellipseStyle = this.translateEllipseStyle(node, parentHasAutoLayout);
        html = `${indent}<div class="${className}" data-figma-id="${node.id}" style="${ellipseStyle}"></div>`;
        break;
        
      case 'LINE':
        // Render line as CSS border
        const lineStyle = this.translateLineStyle(node, parentHasAutoLayout);
        html = `${indent}<div class="${className}" data-figma-id="${node.id}" style="${lineStyle}"></div>`;
        break;
        
      case 'VECTOR':
      case 'BOOLEAN_OPERATION':
      case 'STAR':
      case 'REGULAR_POLYGON':
        // Complex vectors - render as inline SVG from Figma API
        const svgCode = this.getSvgContent(node.id);
        if (svgCode) {
          // Embed inline SVG with class and data attributes, using Figma sizing
          const styledSvg = this.processSvg(svgCode, className, node.id, node);
          html = `${indent}${styledSvg}`;
        } else {
          // Fallback to img tag if SVG content not available
          const vectorStyle = this.translateVectorStyle(node, parentHasAutoLayout);
          const vectorUrl = this.getImageUrl(node.id);
          if (vectorUrl) {
            html = `${indent}<img class="${className}" data-figma-id="${node.id}" src="${vectorUrl}" alt="" style="${vectorStyle}" />`;
          } else {
            html = `${indent}<div class="${className}" data-figma-id="${node.id}" style="${vectorStyle}"></div>`;
          }
        }
        break;
        
      case 'INSTANCE':
      case 'COMPONENT':
        // Component instances - render children or as image
        // Check if this instance has an IMAGE fill - render as <img> directly
        // This handles patterns like .Aspect Ratio Spacer where the image is a fill on the instance
        const instanceHasImageFill = node.fills && node.fills.some(f => f.type === 'IMAGE' && f.visible !== false);
        const instanceImageUrl = this.getImageUrl(node.id);
        if (instanceHasImageFill && instanceImageUrl) {
          const imgStyles = [];
          const sizingH = node.layoutSizingHorizontal || 'FIXED';
          const sizingV = node.layoutSizingVertical || 'FIXED';
          const bbox = node.absoluteBoundingBox;
          if (sizingH === 'FILL') {
            imgStyles.push('width: 100%');
          } else if (bbox) {
            imgStyles.push(`width: ${this.round(bbox.width)}px`);
            imgStyles.push('max-width: 100%');
          }
          // Calculate aspect ratio from bbox
          if (bbox && bbox.width && bbox.height) {
            const ratio = (bbox.width / bbox.height).toFixed(4);
            imgStyles.push(`aspect-ratio: ${ratio}`);
          }
          if (sizingV === 'FILL') {
            imgStyles.push('height: 100%');
          } else {
            imgStyles.push('height: auto');
          }
          imgStyles.push('object-fit: cover');
          imgStyles.push('display: block');
          if (node.cornerRadius) {
            imgStyles.push(`border-radius: ${this.round(node.cornerRadius)}px`);
          }
          html = `${indent}<img class="${className}" data-figma-id="${node.id}" src="${instanceImageUrl}" alt="${node.name}" style="${imgStyles.join('; ')}" />`;
        } else {
          const instanceStyle = this.translateAutoLayoutToCSS(node);
          if (node.children && node.children.length > 0) {
            const instanceChildren = node.children.map(child => this.translateNodeToHTML(child, depth + 1, nodeHasAutoLayout)).join('\n');
            html = `${indent}<div class="${className}" data-figma-id="${node.id}" style="${instanceStyle}">
${instanceChildren}
${indent}</div>`;
          } else {
            const instanceUrl2 = this.getImageUrl(node.id);
            if (instanceUrl2) {
              html = `${indent}<img class="${className}" data-figma-id="${node.id}" src="${instanceUrl2}" alt="${node.name}" style="${instanceStyle}" />`;
            } else {
              html = `${indent}<div class="${className}" data-figma-id="${node.id}" style="${instanceStyle}"></div>`;
            }
          }
        }
        break;
        
      default:
        const defaultChildren = node.children ? 
          node.children.map(child => this.translateNodeToHTML(child, depth + 1, parentHasAutoLayout)).join('\n') : '';
        html = `${indent}<div class="${className}" data-figma-id="${node.id}">
${defaultChildren}
${indent}</div>`;
    }
    
    return html;
  }

  translateEllipseStyle(node, parentHasAutoLayout = false) {
    const styles = [];
    const bbox = node.absoluteBoundingBox;
    
    // Size
    if (bbox) {
      styles.push(`width: ${this.round(bbox.width)}px`);
      styles.push(`height: ${this.round(bbox.height)}px`);
    }
    
    // Make it circular/elliptical
    styles.push('border-radius: 50%');
    
    // Handle arc sweep (partial ellipse) - uses arcData
    if (node.arcData) {
      const { startingAngle, endingAngle, innerRadius } = node.arcData;
      // For partial arcs, we need conic-gradient or clip-path
      if (startingAngle !== 0 || endingAngle !== Math.PI * 2) {
        const startDeg = this.round((startingAngle * 180) / Math.PI);
        const endDeg = this.round((endingAngle * 180) / Math.PI);
        const sweepDeg = endDeg - startDeg;
        // Use conic-gradient for pie/arc effect
        if (node.fills && node.fills.length > 0) {
          const fill = node.fills.find(f => f.visible !== false && f.type === 'SOLID');
          if (fill && fill.color) {
            const r = Math.round(fill.color.r * 255);
            const g = Math.round(fill.color.g * 255);
            const b = Math.round(fill.color.b * 255);
            const a = fill.opacity !== undefined ? fill.opacity : 1;
            styles.push(`background: conic-gradient(from ${startDeg}deg, rgba(${r},${g},${b},${a}) ${sweepDeg}deg, transparent ${sweepDeg}deg)`);
          }
        }
      } else {
        // Full ellipse - use regular fill
        this.applyFillStyles(node, styles);
      }
    } else {
      // Regular ellipse
      this.applyFillStyles(node, styles);
    }
    
    // Stroke
    this.applyStrokeStyles(node, styles);
    
    return styles.join('; ');
  }
  
  translateLineStyle(node, parentHasAutoLayout = false) {
    const styles = [];
    const bbox = node.absoluteBoundingBox;
    
    if (bbox) {
      styles.push(`width: ${this.round(bbox.width)}px`);
      styles.push(`height: ${this.round(bbox.height)}px`);
    }
    
    // Line is typically rendered as a border
    if (node.strokes && node.strokes.length > 0) {
      const stroke = node.strokes.find(s => s.visible !== false);
      if (stroke && stroke.type === 'SOLID' && stroke.color) {
        const r = Math.round(stroke.color.r * 255);
        const g = Math.round(stroke.color.g * 255);
        const b = Math.round(stroke.color.b * 255);
        const a = stroke.opacity !== undefined ? stroke.opacity : 1;
        const weight = node.strokeWeight || 1;
        styles.push(`border-bottom: ${this.round(weight)}px solid rgba(${r},${g},${b},${a})`);
      }
    }
    
    return styles.join('; ');
  }
  
  translateVectorStyle(node, parentHasAutoLayout = false) {
    const styles = [];
    const bbox = node.absoluteBoundingBox;
    
    if (bbox) {
      styles.push(`width: ${this.round(bbox.width)}px`);
      styles.push(`height: ${this.round(bbox.height)}px`);
    }
    
    // For complex vectors rendered as SVG images
    styles.push('object-fit: contain');
    
    return styles.join('; ');
  }
  
  translateVideoStyle(node, parentHasAutoLayout = false) {
    const styles = [];
    const bbox = node.absoluteBoundingBox;
    const sizingH = node.layoutSizingHorizontal || 'FIXED';
    const sizingV = node.layoutSizingVertical || 'FIXED';
    
    // Width
    if (sizingH === 'FILL') {
      styles.push('flex: 1');
      styles.push('width: 100%');
    } else if (sizingH === 'HUG') {
      // Don't set width
    } else if (bbox) {
      styles.push(`width: ${this.round(bbox.width)}px`);
    }
    
    // Height
    if (sizingV === 'FILL') {
      styles.push('flex-grow: 1');
      styles.push('height: 100%');
    } else if (sizingV === 'HUG') {
      // Don't set height
    } else if (bbox) {
      styles.push(`height: ${this.round(bbox.height)}px`);
    }
    
    // Video should cover the container
    styles.push('object-fit: cover');
    
    // Corner radius
    if (node.cornerRadius) {
      styles.push(`border-radius: ${this.round(node.cornerRadius)}px`);
    }
    
    return styles.join('; ');
  }
  
  applyFillStyles(node, styles) {
    if (node.fills && node.fills.length > 0) {
      const fill = node.fills.find(f => f.visible !== false);
      if (fill) {
        if (fill.type === 'SOLID' && fill.color) {
          const r = Math.round(fill.color.r * 255);
          const g = Math.round(fill.color.g * 255);
          const b = Math.round(fill.color.b * 255);
          const a = fill.opacity !== undefined ? fill.opacity : (fill.color.a ?? 1);
          styles.push(`background-color: rgba(${r}, ${g}, ${b}, ${a})`);
        } else if (fill.type === 'IMAGE') {
          // Image fill - use the fetched image URL
          const imageUrl = this.getImageUrl(node.id);
          if (imageUrl) {
            styles.push(`background-image: url('${imageUrl}')`);
            styles.push('background-size: cover');
            styles.push('background-position: center');
            // Handle image scale mode
            if (fill.scaleMode === 'FIT') {
              styles.push('background-size: contain');
              styles.push('background-repeat: no-repeat');
            } else if (fill.scaleMode === 'TILE') {
              styles.push('background-size: auto');
              styles.push('background-repeat: repeat');
            }
          }
        } else if (fill.type && fill.type.includes('GRADIENT')) {
          const gradient = this.applyGradient(fill);
          if (gradient) styles.push(`background: ${gradient}`);
        }
      }
    }
  }
  
  applyStrokeStyles(node, styles) {
    if (node.strokeWeight && node.strokes && node.strokes.length > 0) {
      const stroke = node.strokes.find(s => s.visible !== false);
      if (stroke && stroke.type === 'SOLID' && stroke.color) {
        const r = Math.round(stroke.color.r * 255);
        const g = Math.round(stroke.color.g * 255);
        const b = Math.round(stroke.color.b * 255);
        const a = stroke.opacity !== undefined ? stroke.opacity : (stroke.color.a ?? 1);
        styles.push(`border: ${this.round(node.strokeWeight)}px solid rgba(${r}, ${g}, ${b}, ${a})`);
      }
    }
  }

  translateRectangleStyle(node, parentHasAutoLayout = false) {
    const styles = [];
    
    // Sizing based on Figma's layoutSizingHorizontal/Vertical properties:
    // - FIXED = fixed dimensions from bounding box
    // - HUG = auto-size to content (rare for rectangles)
    // - FILL = flex: 1 to fill available space
    const bbox = node.absoluteBoundingBox;
    const sizingH = node.layoutSizingHorizontal || 'FIXED';
    const sizingV = node.layoutSizingVertical || 'FIXED';
    
    // Width
    if (sizingH === 'FILL') {
      styles.push('flex: 1');
      styles.push('align-self: stretch');
    } else if (sizingH === 'HUG') {
      // Don't set width
    } else if (bbox) {
      styles.push(`width: ${this.round(bbox.width)}px`);
    }
    
    // Height
    if (sizingV === 'FILL') {
      styles.push('flex-grow: 1');
    } else if (sizingV === 'HUG') {
      // Don't set height
    } else if (bbox) {
      styles.push(`height: ${this.round(bbox.height)}px`);
    }
    
    // Min/Max constraints
    if (node.minWidth !== undefined && node.minWidth > 0) styles.push(`min-width: ${this.round(node.minWidth)}px`);
    if (node.maxWidth !== undefined && node.maxWidth < 10000) styles.push(`max-width: ${this.round(node.maxWidth)}px`);
    if (node.minHeight !== undefined && node.minHeight > 0) styles.push(`min-height: ${this.round(node.minHeight)}px`);
    if (node.maxHeight !== undefined && node.maxHeight < 10000) styles.push(`max-height: ${this.round(node.maxHeight)}px`);
    
    // Background - solid, gradient
    this.applyFillStyles(node, styles);
    
    // Corner radius
    if (node.cornerRadius) {
      styles.push(`border-radius: ${this.round(node.cornerRadius)}px`);
    }
    
    // Strokes/borders
    this.applyStrokeStyles(node, styles);
    
    // Effects
    if (node.effects && node.effects.length > 0) {
      const effectCSS = node.effects.map(e => this.applyEffect(e)).filter(Boolean);
      styles.push(...effectCSS);
    }
    
    return styles.join('; ');
  }

  translateTextStyle(node, parentHasAutoLayout = false) {
    const styles = [];
    
    // Reset browser default margins for semantic tags
    styles.push('margin: 0');
    
    // Text sizing - Figma uses multiple properties:
    // textAutoResize: WIDTH_AND_HEIGHT (hug both), HEIGHT (fixed width, hug height), NONE/TRUNCATE (fixed)
    // layoutSizingHorizontal/Vertical: FIXED, HUG, FILL (for text in Auto Layout)
    const textAutoResize = node.style?.textAutoResize || node.textAutoResize;
    const sizingH = node.layoutSizingHorizontal;
    const sizingV = node.layoutSizingVertical;
    const bbox = node.absoluteBoundingBox;
    
    // Width sizing
    if (sizingH === 'FILL') {
      styles.push('flex: 1');
      styles.push('align-self: stretch');
    } else if (sizingH === 'HUG' || textAutoResize === 'WIDTH_AND_HEIGHT') {
      // Hug - don't set width
    } else if (bbox) {
      // FIXED or textAutoResize === 'HEIGHT' or 'NONE'
      styles.push(`width: ${this.round(bbox.width)}px`);
    }
    
    // Height sizing
    if (sizingV === 'FILL') {
      styles.push('flex-grow: 1');
    } else if (sizingV === 'HUG' || textAutoResize === 'WIDTH_AND_HEIGHT' || textAutoResize === 'HEIGHT') {
      // Hug - don't set height
    } else if (bbox) {
      // FIXED
      styles.push(`height: ${this.round(bbox.height)}px`);
    }
    
    // Min/Max constraints
    if (node.minWidth !== undefined && node.minWidth > 0) styles.push(`min-width: ${this.round(node.minWidth)}px`);
    if (node.maxWidth !== undefined && node.maxWidth < 10000) styles.push(`max-width: ${this.round(node.maxWidth)}px`);
    if (node.minHeight !== undefined && node.minHeight > 0) styles.push(`min-height: ${this.round(node.minHeight)}px`);
    if (node.maxHeight !== undefined && node.maxHeight < 10000) styles.push(`max-height: ${this.round(node.maxHeight)}px`);
    
    // Font properties from node.style - check for bound variables first
    if (node.style) {
      // Font family - check for bound variable (use single quotes to avoid breaking style attribute)
      if (node.style.fontFamily) {
        const fallback = `'${node.style.fontFamily}', sans-serif`;
        const fontFamilyValue = this.getBoundVariableValue(node, 'fontFamily', fallback);
        styles.push(`font-family: ${fontFamilyValue}`);
      }
      
      // Font size - check for bound variable
      if (node.style.fontSize) {
        const fallback = `${this.round(node.style.fontSize)}px`;
        const fontSizeValue = this.getBoundVariableValue(node, 'fontSize', fallback);
        styles.push(`font-size: ${fontSizeValue}`);
      }
      
      // Font weight
      if (node.style.fontWeight) {
        styles.push(`font-weight: ${node.style.fontWeight}`);
      }
      
      // Italic detection - check italic flag or font style name
      if (node.style.italic || 
          (node.style.fontPostScriptName && node.style.fontPostScriptName.toLowerCase().includes('italic')) ||
          (node.style.fontStyle && node.style.fontStyle === 'ITALIC')) {
        styles.push(`font-style: italic`);
      }
      
      // Underline detection
      if (node.style.textDecoration === 'UNDERLINE') {
        styles.push(`text-decoration: underline`);
      }
      
      // Text alignment
      if (node.style.textAlignHorizontal) {
        const alignMap = {
          'LEFT': 'left',
          'CENTER': 'center',
          'RIGHT': 'right',
          'JUSTIFIED': 'justify'
        };
        styles.push(`text-align: ${alignMap[node.style.textAlignHorizontal] || 'left'}`);
      }
      
      // Line height - check for percentage vs pixel
      if (node.style.lineHeightPercentFontSize) {
        styles.push(`line-height: ${node.style.lineHeightPercentFontSize}%`);
      } else if (node.style.lineHeightPercent) {
        styles.push(`line-height: ${node.style.lineHeightPercent}%`);
      } else if (node.style.lineHeightPx) {
        styles.push(`line-height: ${node.style.lineHeightPx}px`);
      }
      
      // Letter spacing
      if (node.style.letterSpacing) {
        styles.push(`letter-spacing: ${node.style.letterSpacing}px`);
      }
    }
    
    // Text color - check for bound variables on fills
    if (node.fills && node.fills.length > 0) {
      const fill = node.fills.find(f => f.type === 'SOLID' && f.visible !== false);
      if (fill && fill.color) {
        const r = Math.round(fill.color.r * 255);
        const g = Math.round(fill.color.g * 255);
        const b = Math.round(fill.color.b * 255);
        const a = fill.opacity !== undefined ? fill.opacity : 1;
        const fallbackColor = a === 1 
          ? `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase()
          : `rgba(${r}, ${g}, ${b}, ${a})`;
        
        // Check if fills have bound variables
        const colorValue = this.getBoundVariableValue(node, 'fills', fallbackColor);
        styles.push(`color: ${colorValue}`);
      }
    }
    
    return styles.join('; ');
  }

  getTextTag(node) {
    if (!node.style) return 'p';
    
    const fontSize = node.style.fontSize || 16;
    const fontWeight = node.style.fontWeight || 400;
    
    // Heading logic based on size and weight
    if (fontSize >= 48 || (fontSize >= 32 && fontWeight >= 600)) {
      return 'h1';
    } else if (fontSize >= 32 || (fontSize >= 24 && fontWeight >= 600)) {
      return 'h2';
    } else if (fontSize >= 24 || (fontSize >= 18 && fontWeight >= 600)) {
      return 'h3';
    }
    
    return 'p';
  }

  generateHTML(figmaData, currentUrl = '') {
    let nodeToRender = figmaData;
    
    // Extract specific node if we have nodes response
    if (figmaData.nodes) {
      const firstNodeKey = Object.keys(figmaData.nodes)[0];
      if (firstNodeKey) {
        nodeToRender = figmaData.nodes[firstNodeKey].document;
      }
    }

    const renderedHTML = this.translateNodeToHTML(nodeToRender);

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <script src="https://unpkg.com/@lottiefiles/dotlottie-wc@latest/dist/dotlottie-wc.js" type="module"></script>
    <title>Figma MCP Compiler</title>
    <style>
        * {
            box-sizing: border-box;
        }
        
        body {
            margin: 0;
            padding: 16px;
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background-color: white;
        }
        
        .container {
            display: flex;
            flex-direction: column;
            gap: 16px;
        }
        
        .header-title {
            font-size: 24px;
            font-weight: 700;
            letter-spacing: -0.25px;
            line-height: 1.3;
            margin: 0;
            color: #1e1e1e;
        }
        
        .toolbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 16px;
            flex-wrap: wrap;
        }
        
        .file-info {
            display: flex;
            align-items: center;
            gap: 16px;
        }
        
        .refresh-btn {
            width: 40px;
            height: 40px;
            border: 1px solid #E0E0E0;
            border-radius: 4px;
            background: white;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: background 0.2s;
        }
        
        .refresh-btn:hover {
            background: #f5f5f5;
        }
        
        .refresh-btn svg {
            width: 20px;
            height: 20px;
            color: #C01B1B;
            transition: transform 0.3s ease;
        }
        
        .refresh-btn.loading svg {
            animation: spin 1s linear infinite;
        }
        
        @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
        
        .file-name {
            font-size: 16px;
            font-weight: 400;
            color: #1e1e1e;
        }
        
        .link-input-group {
            display: flex;
            align-items: center;
            gap: 16px;
        }
        
        .url-input {
            width: 400px;
            padding: 10px 12px;
            border: 1px solid #E0E0E0;
            border-radius: 4px;
            font-size: 14px;
            font-family: inherit;
            color: #666;
        }
        
        .url-input:focus {
            outline: none;
            border-color: #1e1e1e;
        }
        
        .load-button {
            display: flex;
            align-items: center;
            gap: 8px;
            background: #1e1e1e;
            color: white;
            border: none;
            padding: 10px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
        }
        
        .load-button:hover {
            background: #333;
        }
        
        .load-button svg {
            width: 16px;
            height: 16px;
        }
        
        .output-toggle {
            display: flex;
            border-radius: 4px;
            overflow: hidden;
            border: 1px solid #C01B1B;
        }
        
        .toggle-btn {
            padding: 10px 16px;
            border: none;
            background: white;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            color: #1e1e1e;
            transition: all 0.2s;
        }
        
        .toggle-btn:not(:last-child) {
            border-right: 1px solid #C01B1B;
        }
        
        .toggle-btn.active {
            background: #C01B1B;
            color: white;
        }
        
        .toggle-btn:hover:not(.active) {
            background: #FEF2F2;
        }
        
        .react-preview-btn {
            background: #61dafb;
            color: #1e1e1e;
            border: none;
            padding: 10px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            margin-left: 10px;
        }
        
        .react-preview-btn:hover {
            background: #4fc3f7;
        }
        
        .divider {
            height: 1px;
            background: #E0E0E0;
            width: 100%;
        }
        
        .figma-output {
            background: white;
            border: 1px solid #E0E0E0;
            border-radius: 4px;
            padding: 20px;
            overflow-x: auto;
        }
        
        .code-output {
            background: #1e1e1e;
            color: #d4d4d4;
            padding: 15px;
            border-radius: 4px;
            font-family: 'Monaco', 'Menlo', monospace;
            font-size: 12px;
            overflow-x: auto;
            white-space: pre-wrap;
            max-height: 500px;
            overflow-y: auto;
        }
        
        .copy-btn {
            background: #333;
            color: white;
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            margin-bottom: 10px;
        }
        
        .copy-btn:hover {
            background: #444;
        }
        
        .error-message {
            color: #C01B1B;
            background: #FEF2F2;
            padding: 10px 15px;
            border-radius: 4px;
            margin-top: 10px;
            display: none;
        }
        
        .success-message {
            color: #27ae60;
            background: #f0fdf4;
            padding: 10px 15px;
            border-radius: 4px;
            margin-top: 10px;
            display: none;
        }
        
        h3 {
            margin: 0 0 10px 0;
            font-size: 16px;
            font-weight: 600;
        }
        
        h4 {
            margin: 15px 0 10px 0;
            font-size: 14px;
            font-weight: 600;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1 class="header-title">FIGMA MCP COMPILER</h1>
        
        <div class="toolbar">
            <div class="file-info">
                <button class="refresh-btn" onclick="refreshFromFigma()" title="Refresh">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M1 4v6h6M23 20v-6h-6"/>
                        <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>
                    </svg>
                </button>
                <span class="file-name">File: ${figmaData.name || 'Untitled'}</span>
            </div>
            
            <div class="link-input-group">
                <input type="text" class="url-input" id="figmaUrl" placeholder="Figma design link" value="${currentUrl}">
                <button class="load-button" onclick="loadFromFigma()">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                        <line x1="8" y1="21" x2="16" y2="21"/>
                        <line x1="12" y1="17" x2="12" y2="21"/>
                    </svg>
                    Load
                </button>
            </div>
            
            <div class="output-toggle">
                <button class="toggle-btn active" onclick="setOutputMode('preview')" id="btn-preview">Preview</button>
                <button class="toggle-btn" onclick="setOutputMode('html')" id="btn-html">HTML/CSS</button>
                <button class="toggle-btn" onclick="setOutputMode('react')" id="btn-react">React</button>
            </div>
            
            <button class="react-preview-btn" onclick="openReactPreview()" id="reactPreviewBtn" style="display: none;">
                ⚛️ Live React
            </button>
        </div>
        
        <div class="divider"></div>
        
        <div id="errorMsg" class="error-message"></div>
        <div id="successMsg" class="success-message"></div>
        
        <!-- Preview Mode -->
        <div id="output-preview">
            <div class="figma-output">${renderedHTML}</div>
        </div>
        
        <!-- HTML/CSS Code Mode -->
        <div id="output-html" style="display: none;">
            <button class="copy-btn" onclick="copyCode('html')">📋 Copy HTML</button>
            <pre class="code-output" id="html-code"></pre>
        </div>
        
        <!-- React Code Mode -->
        <div id="output-react" style="display: none;">
            <button class="copy-btn" onclick="copyCode('react')">📋 Copy React</button>
            <button class="copy-btn" onclick="copyCode('css')" style="margin-left: 5px;">📋 Copy CSS Module</button>
            <pre class="code-output" id="react-code"></pre>
            <h4>CSS Module (styles.module.css):</h4>
            <pre class="code-output" id="css-module-code"></pre>
        </div>
    </div>
    
    <script>
        // Code Connect mappings from server
        const codeConnectMap = ${JSON.stringify(this.codeConnectMap)};
        
        async function loadFromFigma() {
            const urlInput = document.getElementById('figmaUrl');
            const errorMsg = document.getElementById('errorMsg');
            const successMsg = document.getElementById('successMsg');
            const button = document.querySelector('.load-button');
            
            const url = urlInput.value.trim();
            if (!url) {
                errorMsg.textContent = 'Please enter a Figma URL';
                errorMsg.style.display = 'block';
                successMsg.style.display = 'none';
                return;
            }
            
            button.disabled = true;
            button.textContent = '📂 Loading...';
            errorMsg.style.display = 'none';
            successMsg.style.display = 'none';
            
            try {
                const response = await fetch('/load?url=' + encodeURIComponent(url));
                const data = await response.json();
                
                if (data.success) {
                    successMsg.textContent = 'Design loaded successfully!';
                    successMsg.style.display = 'block';
                    setTimeout(() => location.reload(), 500);
                } else {
                    errorMsg.textContent = 'Load failed: ' + data.error;
                    errorMsg.style.display = 'block';
                    button.disabled = false;
                    button.textContent = '📂 Load';
                }
            } catch (error) {
                errorMsg.textContent = 'Load failed: ' + error.message;
                errorMsg.style.display = 'block';
                button.disabled = false;
                button.textContent = '📂 Load';
            }
        }
        
        async function refreshFromFigma() {
            const button = document.querySelector('.refresh-btn');
            const errorMsg = document.getElementById('errorMsg');
            const successMsg = document.getElementById('successMsg');
            
            button.disabled = true;
            button.classList.add('loading');
            errorMsg.style.display = 'none';
            successMsg.style.display = 'none';
            
            try {
                const response = await fetch('/refresh');
                const data = await response.json();
                
                if (data.success) {
                    location.reload();
                } else {
                    errorMsg.textContent = 'Refresh failed: ' + data.error;
                    errorMsg.style.display = 'block';
                    button.disabled = false;
                    button.classList.remove('loading');
                }
            } catch (error) {
                errorMsg.textContent = 'Refresh failed: ' + error.message;
                errorMsg.style.display = 'block';
                button.disabled = false;
                button.classList.remove('loading');
            }
        }
        
        // Allow Enter key to load
        document.getElementById('figmaUrl').addEventListener('keypress', function(e) {
            if (e.key === 'Enter') loadFromFigma();
        });
        
        // Output mode switching
        let currentMode = 'preview';
        
        function setOutputMode(mode) {
            currentMode = mode;
            
            // Update button states
            document.querySelectorAll('.toggle-btn').forEach(btn => btn.classList.remove('active'));
            document.getElementById('btn-' + mode).classList.add('active');
            
            // Show/hide output containers
            document.getElementById('output-preview').style.display = mode === 'preview' ? 'block' : 'none';
            document.getElementById('output-html').style.display = mode === 'html' ? 'block' : 'none';
            document.getElementById('output-react').style.display = mode === 'react' ? 'block' : 'none';
            
            // Generate code when switching to code modes
            if (mode === 'html') {
                generateHTMLCode();
            } else if (mode === 'react') {
                generateReactCode();
            }
        }
        
        function generateHTMLCode() {
            const figmaOutput = document.querySelector('.figma-output');
            const htmlCode = figmaOutput.innerHTML;
            document.getElementById('html-code').textContent = formatHTML(htmlCode);
        }
        
        function generateReactCode() {
            const figmaOutput = document.querySelector('.figma-output');
            const htmlCode = figmaOutput.innerHTML;
            
            // Convert HTML to React JSX
            const { jsx, cssModule, componentName } = htmlToReact(htmlCode);
            
            document.getElementById('react-code').textContent = jsx;
            document.getElementById('css-module-code').textContent = cssModule;
        }
        
        function htmlToReact(html) {
            const componentName = 'FigmaComponent';
            const styles = new Map();
            const imports = new Set();
            let styleIndex = 0;
            
            // First pass: Replace Code Connect components
            let jsx = html;
            
            // Find elements with data-figma-id and check if they have Code Connect mappings
            Object.entries(codeConnectMap).forEach(([nodeId, mapping]) => {
                if (mapping && mapping.componentName) {
                    // Build props string
                    const propsStr = Object.entries(mapping.props || {})
                        .map(([key, val]) => {
                            if (typeof val === 'string') {
                                return key + '="' + val + '"';
                            } else if (typeof val === 'boolean') {
                                return val ? key : '';
                            } else {
                                return key + '={' + JSON.stringify(val) + '}';
                            }
                        })
                        .filter(Boolean)
                        .join(' ');
                    
                    // Create the component JSX
                    const componentJsx = '<' + mapping.componentName + (propsStr ? ' ' + propsStr : '') + ' />';
                    
                    // Add import
                    imports.add("import { " + mapping.componentName + " } from '@/components/" + mapping.componentName + "';");
                    
                    // Replace the HTML element with the component
                    // Match elements with this data-figma-id
                    const regex = new RegExp('<[^>]*data-figma-id="' + nodeId.replace(':', '\\\\:') + '"[^>]*>([\\\\s\\\\S]*?)</[^>]+>', 'g');
                    jsx = jsx.replace(regex, componentJsx);
                    
                    // Also try to match self-closing or simple elements
                    const regexSimple = new RegExp('<[^>]*data-figma-id="' + nodeId.replace(':', '\\\\:') + '"[^>]*/>', 'g');
                    jsx = jsx.replace(regexSimple, componentJsx);
                }
            });
            
            // Second pass: Convert remaining HTML to React
            jsx = jsx
                // Convert class to className
                .replace(/\\bclass="/g, 'className="')
                // Convert style strings to CSS module references
                .replace(/style="([^"]*)"/g, (match, styleStr) => {
                    if (!styleStr.trim()) return '';
                    
                    // Generate a unique style name
                    const styleName = 'style' + (styleIndex++);
                    
                    // Parse inline styles to CSS
                    const cssProps = styleStr.split(';')
                        .filter(s => s.trim())
                        .map(s => {
                            const [prop, val] = s.split(':').map(x => x.trim());
                            if (!prop || !val) return '';
                            // Convert camelCase CSS properties
                            const cssProp = prop.replace(/([A-Z])/g, '-$1').toLowerCase();
                            return '  ' + cssProp + ': ' + val + ';';
                        })
                        .filter(Boolean)
                        .join('\\n');
                    
                    styles.set(styleName, cssProps);
                    return 'className={styles.' + styleName + '}';
                })
                // Handle self-closing tags
                .replace(/<(img|input|br|hr)([^>]*)>/g, '<$1$2 />')
                // Fix boolean attributes
                .replace(/\\b(autoplay|loop|muted|playsinline)(?=[\\s>])/g, '$1={true}');
            
            // Build CSS module content
            let cssModule = '/* styles.module.css */\\n\\n';
            styles.forEach((css, name) => {
                cssModule += '.' + name + ' {\\n' + css + '\\n}\\n\\n';
            });
            
            // Build imports string
            const importsStr = imports.size > 0 ? Array.from(imports).join('\\n') + '\\n' : '';
            
            // Build React component
            const reactCode = "import React from 'react';\\nimport styles from './styles.module.css';\\n" + importsStr + "\\nexport default function " + componentName + "() {\\n  return (\\n    <>\\n" + indent(jsx, 6) + "\\n    </>\\n  );\\n}";
            
            return { jsx: reactCode, cssModule, componentName };
        }
        
        function indent(str, spaces) {
            const pad = ' '.repeat(spaces);
            return str.split('\\n').map(line => pad + line).join('\\n');
        }
        
        function formatHTML(html) {
            // Simple HTML formatting
            let formatted = '';
            let indentLevel = 0;
            const lines = html.replace(/></g, '>\\n<').split('\\n');
            
            lines.forEach(line => {
                line = line.trim();
                if (!line) return;
                
                // Decrease indent for closing tags
                if (line.startsWith('</')) {
                    indentLevel = Math.max(0, indentLevel - 1);
                }
                
                formatted += '  '.repeat(indentLevel) + line + '\\n';
                
                // Increase indent for opening tags (not self-closing)
                if (line.startsWith('<') && !line.startsWith('</') && !line.endsWith('/>') && !line.includes('</')) {
                    indentLevel++;
                }
            });
            
            return formatted.trim();
        }
        
        function copyCode(type) {
            let code = '';
            if (type === 'html') {
                code = document.getElementById('html-code').textContent;
            } else if (type === 'react') {
                code = document.getElementById('react-code').textContent;
            } else if (type === 'css') {
                code = document.getElementById('css-module-code').textContent;
            }
            
            navigator.clipboard.writeText(code).then(() => {
                const btn = event.target;
                const originalText = btn.textContent;
                btn.textContent = '✅ Copied!';
                setTimeout(() => btn.textContent = originalText, 1500);
            });
        }
    </script>
</body>
</html>`;
  }

  // Generate React preview entry code for esbuild bundling
  // This creates a script that hydrates Code Connect components into existing HTML
  generateReactPreviewEntry(componentTree) {
    const npmPackage = componentTree?.npmPackage || 'rk-designsystem';
    const codeConnectMappings = componentTree?.codeConnectMappings || {};
    
    // Map Code Connect names to actual rk-designsystem export names
    const nameMap = {
      'Body': 'Paragraph',
    };
    
    // Known exports from rk-designsystem (components only)
    const knownExports = new Set([
      'Alert', 'Avatar', 'Badge', 'BadgePosition', 'Breadcrumbs', 'BreadcrumbsItem',
      'BreadcrumbsLink', 'BreadcrumbsList', 'Button', 'Card', 'CardBlock', 'Carousel',
      'Checkbox', 'Chip', 'CrossCorner', 'DateInput', 'DatePicker', 'Details', 'Dialog',
      'Divider', 'Dropdown', 'DropdownButton', 'DropdownHeading', 'DropdownItem',
      'DropdownList', 'DropdownTrigger', 'DropdownTriggerContext', 'ErrorSummary',
      'Field', 'FieldCounter', 'FieldDescription', 'Fieldset', 'Footer', 'Header',
      'Heading', 'Input', 'Label', 'LanguageProvider', 'Link', 'List', 'Pagination',
      'PaginationButton', 'PaginationItem', 'PaginationList', 'Paragraph', 'Popover',
      'Radio', 'Search', 'Select', 'SkeletonLoader', 'SkipLink', 'Spinner', 'Suggestion',
      'Switch', 'Table', 'Tabs', 'Tag', 'Textarea', 'Textfield', 'ToggleGroup', 'Tooltip',
      'ValidationMessage'
    ]);
    
    // Get unique component names from Code Connect mappings
    // Filter out invalid JS identifiers and non-exported names
    const componentNames = new Set();
    const originalToExport = {}; // maps original CC name -> actual export name
    for (const mapping of Object.values(codeConnectMappings)) {
      if (!mapping.componentName) continue;
      if (!/^[a-zA-Z_$]/.test(mapping.componentName)) continue;
      const exportName = nameMap[mapping.componentName] || mapping.componentName;
      if (knownExports.has(exportName)) {
        componentNames.add(exportName);
        originalToExport[mapping.componentName] = exportName;
      }
    }
    
    const componentImports = componentNames.size > 0 
      ? `import { ${Array.from(componentNames).join(', ')} } from '${npmPackage}';`
      : '';
    
    // Build the component map for runtime lookup (map both original and export names)
    const componentMapEntries = [];
    for (const exportName of componentNames) {
      componentMapEntries.push(`  '${exportName}': ${exportName}`);
    }
    // Also map original Code Connect names to the export
    for (const [original, exportName] of Object.entries(originalToExport)) {
      if (original !== exportName) {
        componentMapEntries.push(`  '${original}': ${exportName}`);
      }
    }
    const componentMapStr = componentMapEntries.join(',\n');
    
    return `
import React from 'react';
import { createRoot } from 'react-dom/client';
${componentImports}

// Map of component names to actual components
const ComponentMap = {
${componentMapStr}
};

// Code Connect mappings from Figma
const codeConnectMappings = ${JSON.stringify(codeConnectMappings)};

// Map Figma prop values to design system prop values
function mapFigmaPropsToDesignSystem(componentName, figmaProps) {
  const props = {};
  
  // Size mapping: Figma uses xxlarge/xlarge/large etc, design system uses 2xl/xl/lg etc
  const sizeMap = {
    'xxlarge': '2xl',
    'xlarge': 'xl',
    'large': 'lg',
    'medium': 'md',
    'small': 'sm',
    'xsmall': 'xs',
    'xxsmall': '2xs'
  };
  
  // Color mapping: Figma uses main/neutral/danger, design system uses accent/neutral/danger
  const colorMap = {
    'main': 'accent',
    'neutral': 'neutral',
    'danger': 'danger',
    'success': 'success',
    'warning': 'warning',
    'info': 'info'
  };
  
  for (const [key, value] of Object.entries(figmaProps)) {
    const lowerKey = key.toLowerCase();
    const lowerValue = typeof value === 'string' ? value.toLowerCase() : value;
    
    if (lowerKey === 'size') {
      // Map size to data-size with correct value
      const mappedSize = sizeMap[lowerValue] || value;
      props['data-size'] = mappedSize;
    } else if (lowerKey === 'color') {
      // Map color to data-color with correct value
      const mappedColor = colorMap[lowerValue] || value;
      props['data-color'] = mappedColor;
    } else if (lowerKey === 'weight') {
      // Weight is not a prop in the design system - it's handled by CSS
      // Skip it or map to style if needed
    } else if (lowerKey === 'state') {
      // Skip state prop (default/hover/active/disabled) - handled by CSS
    } else {
      props[key] = value;
    }
  }
  
  // For Heading, add level prop based on original element
  if (componentName === 'Heading') {
    props.level = 1; // Default to h1, will be overridden below
  }
  
  return props;
}

// Hydrate Code Connect components into existing HTML
function hydrateCodeConnectComponents() {
  for (const [nodeId, mapping] of Object.entries(codeConnectMappings)) {
    const element = document.querySelector('[data-figma-id="' + nodeId + '"]');
    if (!element) continue;
    
    const Component = ComponentMap[mapping.componentName];
    if (!Component) {
      console.warn('Component not found:', mapping.componentName);
      continue;
    }
    
    // Get text content from the original element (look for nested text)
    const textContent = element.textContent?.trim() || '';
    
    // Map Figma props to design system props
    const props = mapFigmaPropsToDesignSystem(mapping.componentName, mapping.props || {});
    
    // For Heading, determine level from original element tag and extract font weight from Figma text node
    if (mapping.componentName === 'Heading') {
      const tagName = element.tagName.toLowerCase();
      const levelMatch = tagName.match(/h([1-6])/);
      if (levelMatch) {
        props.level = parseInt(levelMatch[1]);
      }
      // Extract font weight from the Figma text node children
      const textChild = mapping.nodeData?.children?.find(c => c.type === 'TEXT');
      if (textChild?.style?.fontWeight) {
        props.style = { fontWeight: textChild.style.fontWeight };
      }
    }
    
    // Copy inline styles from original element to preserve layout
    const originalStyle = element.getAttribute('style') || '';
    const computedStyleBefore = window.getComputedStyle(element);
    
    // Create wrapper with original element's layout styles
    const wrapper = document.createElement('div');
    wrapper.style.cssText = originalStyle;
    wrapper.style.display = computedStyleBefore.display === 'none' ? 'flex' : computedStyleBefore.display;
    
    element.parentNode.insertBefore(wrapper, element);
    element.remove(); // Remove original element entirely
    
    try {
      const root = createRoot(wrapper);
      root.render(React.createElement(Component, props, textContent || null));
    } catch (err) {
      console.error('Failed to hydrate', mapping.componentName, err);
      wrapper.innerHTML = textContent; // Fallback to text
    }
  }
}

// Run when DOM is ready
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hydrateCodeConnectComponents);
  } else {
    hydrateCodeConnectComponents();
  }
}
`;
  }

  // Collect all component names used in the tree
  collectUsedComponents(components, usedSet) {
    if (!components || !Array.isArray(components)) return;
    
    for (const comp of components) {
      if (comp.componentName && comp.isDesignSystem) {
        usedSet.add(comp.componentName);
      }
      if (comp.children) {
        this.collectUsedComponents(comp.children, usedSet);
      }
    }
  }

  // Build JSX tree from component data
  buildJSXTree(components, indent = 6) {
    if (!components || !Array.isArray(components) || components.length === 0) {
      return '';
    }
    
    const pad = ' '.repeat(indent);
    const lines = [];
    
    for (const comp of components) {
      if (comp.isDesignSystem && comp.componentName) {
        // Render as design system component
        const propsStr = this.buildPropsString(comp.props);
        const childrenJsx = comp.children ? this.buildJSXTree(comp.children, indent + 2) : '';
        
        if (childrenJsx) {
          lines.push(`${pad}<${comp.componentName}${propsStr}>`);
          lines.push(childrenJsx);
          lines.push(`${pad}</${comp.componentName}>`);
        } else if (comp.textContent) {
          lines.push(`${pad}<${comp.componentName}${propsStr}>${this.escapeJSX(comp.textContent)}</${comp.componentName}>`);
        } else {
          lines.push(`${pad}<${comp.componentName}${propsStr} />`);
        }
      } else {
        // Render as HTML element with inline styles
        const tag = comp.tag || 'div';
        const styleStr = comp.style ? ` style={${JSON.stringify(comp.style)}}` : '';
        const classStr = comp.className ? ` className="${comp.className}"` : '';
        const childrenJsx = comp.children ? this.buildJSXTree(comp.children, indent + 2) : '';
        
        if (childrenJsx) {
          lines.push(`${pad}<${tag}${classStr}${styleStr}>`);
          lines.push(childrenJsx);
          lines.push(`${pad}</${tag}>`);
        } else if (comp.textContent) {
          lines.push(`${pad}<${tag}${classStr}${styleStr}>${this.escapeJSX(comp.textContent)}</${tag}>`);
        } else {
          lines.push(`${pad}<${tag}${classStr}${styleStr} />`);
        }
      }
    }
    
    return lines.join('\n');
  }

  // Build props string for JSX
  buildPropsString(props) {
    if (!props || Object.keys(props).length === 0) return '';
    
    const parts = [];
    for (const [key, value] of Object.entries(props)) {
      if (typeof value === 'string') {
        parts.push(`${key}="${value}"`);
      } else if (typeof value === 'boolean') {
        parts.push(value ? key : '');
      } else {
        parts.push(`${key}={${JSON.stringify(value)}}`);
      }
    }
    return parts.length > 0 ? ' ' + parts.filter(Boolean).join(' ') : '';
  }

  // Escape text for JSX
  escapeJSX(text) {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/{/g, '&#123;')
      .replace(/}/g, '&#125;');
  }

  // Generate React component code from rendered HTML for zip export
  generateReactComponentCode(renderedHTML) {
    let jsx = renderedHTML;
    const cssRules = [];
    const imports = new Set();
    let classCounter = 0;

    // Replace Code Connect components with design system imports
    if (this.codeConnectMap && Object.keys(this.codeConnectMap).length > 0) {
      for (const [nodeId, mapping] of Object.entries(this.codeConnectMap)) {
        const pattern = 'data-figma-id="' + nodeId + '"';
        if (jsx.includes(pattern)) {
          imports.add(mapping.componentName);
          const idx = jsx.indexOf(pattern);
          let tagStart = idx;
          while (tagStart > 0 && jsx[tagStart] !== '<') tagStart--;
          let depth = 1;
          let pos = jsx.indexOf('>', idx) + 1;
          const tagMatch = jsx.substring(tagStart, pos).match(/<([a-z0-9]+)/i);
          const tagName = tagMatch ? tagMatch[1] : 'div';
          while (depth > 0 && pos < jsx.length) {
            const nextOpen = jsx.indexOf('<' + tagName, pos);
            const nextClose = jsx.indexOf('</' + tagName, pos);
            if (nextClose === -1) break;
            if (nextOpen !== -1 && nextOpen < nextClose) {
              depth++;
              pos = nextOpen + 1;
            } else {
              depth--;
              pos = nextClose + tagName.length + 3;
            }
          }
          const before = jsx.substring(0, tagStart);
          const after = jsx.substring(pos);
          // Build props string from mapping
          const propsStr = mapping.props ? Object.entries(mapping.props)
            .map(([k, v]) => `${k}="${v}"`)
            .join(' ') : '';
          jsx = before + '<' + mapping.componentName + (propsStr ? ' ' + propsStr : '') + ' />' + after;
        }
      }
    }

    // Replace class with className
    jsx = jsx.replace(/\bclass="/g, 'className="');

    // Extract inline styles into CSS module classes
    jsx = jsx.replace(/style="([^"]*)"/g, (match, styleStr) => {
      const className = 'figmaStyle' + (++classCounter);
      const cssProps = styleStr.split(';').filter(s => s.trim()).map(s => {
        const parts = s.split(':');
        const prop = parts[0]?.trim();
        const val = parts.slice(1).join(':')?.trim();
        return prop && val ? '  ' + prop + ': ' + val + ';' : '';
      }).filter(Boolean).join('\n');
      if (cssProps) {
        cssRules.push('.' + className + ' {\n' + cssProps + '\n}');
      }
      return 'className={styles.' + className + '}';
    });

    // Build imports string
    const dsImports = imports.size > 0
      ? "import { " + Array.from(imports).join(', ') + " } from 'rk-designsystem';\n"
      : '';

    const componentCode = `import React from 'react';
import styles from './FigmaComponent.module.css';
${dsImports}
export default function FigmaComponent() {
  return (
    <>
${jsx.split('\n').map(line => '      ' + line).join('\n')}
    </>
  );
}
`;

    const cssModuleCode = '/* Generated by Figma MCP Compiler */\n\n' + cssRules.join('\n\n');

    return { componentCode, cssModuleCode, imports: Array.from(imports) };
  }

  // Generate React preview page HTML
  generateReactPreviewPage(figmaData) {
    // Build component tree from Figma data and Code Connect mappings
    // Store it in instance for the bundle endpoint to use
    this.currentComponentTree = this.buildComponentTree(figmaData);
    
    // Generate the same HTML/CSS output as the normal preview
    const renderedHTML = figmaData ? this.translateNodeToHTML(this.extractNodeToRender(figmaData)) : '<p>No design loaded</p>';
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>React Preview - Figma MCP Compiler</title>
    <!-- Design System CSS (served from local node_modules) -->
    <link rel="stylesheet" href="/node_modules/@digdir/designsystemet-css/dist/src/index.css">
    <link rel="stylesheet" href="/node_modules/rk-design-tokens/design-tokens-build/theme.css">
    <link rel="stylesheet" href="/node_modules/rk-designsystem/dist/rk-designsystem.css">
    <link href="https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@200;300;400;500;600;700;800;900&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; }
        body {
            font-family: 'Source Sans 3', sans-serif;
            margin: 0;
            padding: 20px;
            background: #f5f5f5;
        }
        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 20px;
        }
        .header h1 {
            font-size: 14px;
            font-weight: 600;
            color: #1e1e1e;
            margin: 0;
            letter-spacing: 1px;
        }
        .back-btn {
            background: #1e1e1e;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
        }
        .back-btn:hover { background: #333; }
        .preview-container {
            background: white !important;
            border-radius: 8px;
            padding: 30px;
            min-height: 400px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.08);
        }
        .hydration-status {
            position: fixed;
            bottom: 20px;
            right: 20px;
            background: #1e1e1e;
            color: white;
            padding: 10px 16px;
            border-radius: 6px;
            font-size: 13px;
            z-index: 1000;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>REACT PREVIEW</h1>
        <button class="back-btn" onclick="window.location.href='/compiler'">← Back to Compiler</button>
    </div>
    <div class="preview-container">
        ${renderedHTML}
    </div>
    <div class="hydration-status" id="hydrationStatus">⏳ Loading React...</div>
    <script>
        // Load the bundled React components that will hydrate into the existing HTML
        const script = document.createElement('script');
        script.src = '/api/react-bundle';
        script.onload = () => {
            document.getElementById('hydrationStatus').innerHTML = '✅ React components hydrated';
            setTimeout(() => {
                document.getElementById('hydrationStatus').style.display = 'none';
            }, 3000);
        };
        script.onerror = () => {
            document.getElementById('hydrationStatus').innerHTML = '❌ Failed to load React';
            document.getElementById('hydrationStatus').style.background = '#C62828';
        };
        document.body.appendChild(script);
    </script>
</body>
</html>`;
  }
  
  // Helper to extract the node to render from Figma data
  extractNodeToRender(figmaData) {
    if (!figmaData) return null;
    if (figmaData.nodes) {
      const firstNodeKey = Object.keys(figmaData.nodes)[0];
      if (firstNodeKey) {
        return figmaData.nodes[firstNodeKey].document;
      }
    }
    return figmaData;
  }

  // Build component tree from Figma data for React rendering
  buildComponentTree(figmaData) {
    if (!figmaData) return { npmPackage: 'rk-designsystem', codeConnectMappings: {} };
    
    // Get npm package from config (default to rk-designsystem)
    const npmPackage = 'rk-designsystem';
    
    // Pass the Code Connect mappings directly - these will be used to hydrate components
    return {
      npmPackage,
      codeConnectMappings: this.codeConnectMap || {}
    };
  }

  // Convert Figma node to component tree structure
  nodeToComponentTree(node, depth = 0) {
    if (!node) return null;
    if (node.visible === false) return null;
    
    const result = {
      id: node.id,
      name: node.name,
      type: node.type
    };
    
    // Check if this node maps to a design system component via Code Connect
    const codeConnect = this.codeConnectMap[node.id];
    if (codeConnect) {
      result.isDesignSystem = true;
      result.componentName = codeConnect.componentName;
      result.props = codeConnect.props || {};
    } else {
      result.isDesignSystem = false;
      result.tag = this.getHTMLTag(node);
      result.style = this.getInlineStyles(node);
      result.className = this.getClassName(node.name);
    }
    
    // Handle text content
    if (node.type === 'TEXT' && node.characters) {
      result.textContent = node.characters;
    }
    
    // Process children
    if (node.children && Array.isArray(node.children)) {
      result.children = node.children
        .map(child => this.nodeToComponentTree(child, depth + 1))
        .filter(Boolean);
    }
    
    return result;
  }

  // Get HTML tag for a node
  getHTMLTag(node) {
    if (node.type === 'TEXT') {
      const name = (node.name || '').toLowerCase();
      if (name.includes('h1') || name.includes('heading')) return 'h1';
      if (name.includes('h2')) return 'h2';
      if (name.includes('h3')) return 'h3';
      if (name.includes('button')) return 'button';
      if (name.includes('link')) return 'a';
      return 'p';
    }
    if (node.type === 'VECTOR' || node.type === 'BOOLEAN_OPERATION') return 'svg';
    if (node.type === 'RECTANGLE' && this.hasImageFill(node)) return 'img';
    return 'div';
  }

  // Get inline styles object for React
  getInlineStyles(node) {
    const styles = {};
    const bbox = node.absoluteBoundingBox;
    
    if (bbox) {
      styles.width = `${Math.round(bbox.width)}px`;
      styles.height = `${Math.round(bbox.height)}px`;
    }
    
    if (node.layoutMode) {
      styles.display = 'flex';
      styles.flexDirection = node.layoutMode === 'VERTICAL' ? 'column' : 'row';
      if (node.itemSpacing) styles.gap = `${node.itemSpacing}px`;
    }
    
    if (node.fills && node.fills.length > 0) {
      const fill = node.fills.find(f => f.visible !== false && f.type === 'SOLID');
      if (fill && fill.color) {
        const { r, g, b } = fill.color;
        const a = fill.opacity ?? 1;
        if (node.type === 'TEXT') {
          styles.color = `rgba(${Math.round(r*255)}, ${Math.round(g*255)}, ${Math.round(b*255)}, ${a})`;
        } else {
          styles.backgroundColor = `rgba(${Math.round(r*255)}, ${Math.round(g*255)}, ${Math.round(b*255)}, ${a})`;
        }
      }
    }
    
    if (node.style) {
      if (node.style.fontFamily) styles.fontFamily = `'${node.style.fontFamily}', sans-serif`;
      if (node.style.fontSize) styles.fontSize = `${node.style.fontSize}px`;
      if (node.style.fontWeight) styles.fontWeight = node.style.fontWeight;
      if (node.style.textAlignHorizontal) {
        const alignMap = { LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' };
        styles.textAlign = alignMap[node.style.textAlignHorizontal] || 'left';
      }
    }
    
    if (node.cornerRadius) styles.borderRadius = `${node.cornerRadius}px`;
    if (node.paddingLeft) styles.paddingLeft = `${node.paddingLeft}px`;
    if (node.paddingRight) styles.paddingRight = `${node.paddingRight}px`;
    if (node.paddingTop) styles.paddingTop = `${node.paddingTop}px`;
    if (node.paddingBottom) styles.paddingBottom = `${node.paddingBottom}px`;
    
    return Object.keys(styles).length > 0 ? styles : undefined;
  }

  // Check if node has image fill
  hasImageFill(node) {
    return node.fills && node.fills.some(f => f.type === 'IMAGE' && f.visible !== false);
  }

  // Generate setup page HTML
  generateSetupPage() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Figma MCP Compiler - Setup</title>
    <link href="https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        * {
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Source Sans 3', sans-serif;
            margin: 0;
            padding: 0;
            background: #f5f5f5;
            min-height: 100vh;
        }
        
        .container {
            max-width: 700px;
            margin: 0 auto;
            padding: 40px 20px;
        }
        
        .header {
            text-align: center;
            margin-bottom: 40px;
        }
        
        .header h1 {
            font-size: 32px;
            font-weight: 700;
            color: #1e1e1e;
            margin: 0 0 10px 0;
        }
        
        .header p {
            font-size: 16px;
            color: #666;
            margin: 0;
        }
        
        .card {
            background: white;
            border-radius: 8px;
            padding: 30px;
            margin-bottom: 20px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.08);
        }
        
        .card h2 {
            font-size: 18px;
            font-weight: 600;
            color: #1e1e1e;
            margin: 0 0 20px 0;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .card h2 .step-number {
            background: #C01B1B;
            color: white;
            width: 28px;
            height: 28px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
        }
        
        .how-it-works {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 20px;
            margin-bottom: 20px;
        }
        
        .step {
            text-align: center;
            padding: 15px;
        }
        
        .step-icon {
            font-size: 32px;
            margin-bottom: 10px;
        }
        
        .step-title {
            font-weight: 600;
            font-size: 14px;
            color: #1e1e1e;
            margin-bottom: 5px;
        }
        
        .step-desc {
            font-size: 12px;
            color: #666;
        }
        
        .no-ai-badge {
            background: #E8F5E9;
            color: #2E7D32;
            padding: 8px 16px;
            border-radius: 20px;
            font-size: 13px;
            font-weight: 500;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            margin-top: 15px;
        }
        
        .form-group {
            margin-bottom: 20px;
        }
        
        .form-group label {
            display: block;
            font-size: 14px;
            font-weight: 500;
            color: #1e1e1e;
            margin-bottom: 8px;
        }
        
        .form-group .hint {
            font-size: 12px;
            color: #888;
            margin-top: 6px;
        }
        
        .form-group .hint a {
            color: #C01B1B;
        }
        
        .input-group {
            display: flex;
            gap: 10px;
        }
        
        .input-group input {
            flex: 1;
        }
        
        input[type="text"],
        input[type="password"],
        input[type="url"] {
            width: 100%;
            padding: 12px 14px;
            border: 1px solid #ddd;
            border-radius: 6px;
            font-size: 14px;
            font-family: inherit;
        }
        
        input:focus {
            outline: none;
            border-color: #C01B1B;
        }
        
        .btn {
            padding: 12px 20px;
            border: none;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            font-family: inherit;
            transition: all 0.2s;
        }
        
        .btn-primary {
            background: #C01B1B;
            color: white;
        }
        
        .btn-primary:hover {
            background: #a01717;
        }
        
        .btn-secondary {
            background: #1e1e1e;
            color: white;
        }
        
        .btn-secondary:hover {
            background: #333;
        }
        
        .btn-outline {
            background: white;
            color: #1e1e1e;
            border: 1px solid #ddd;
        }
        
        .btn-outline:hover {
            background: #f5f5f5;
        }
        
        .status-indicator {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-size: 13px;
            padding: 6px 12px;
            border-radius: 4px;
            margin-top: 10px;
        }
        
        .status-success {
            background: #E8F5E9;
            color: #2E7D32;
        }
        
        .status-error {
            background: #FFEBEE;
            color: #C62828;
        }
        
        .status-pending {
            background: #FFF3E0;
            color: #E65100;
        }
        
        .install-status {
            margin-top: 15px;
            padding: 12px 15px;
            border-radius: 6px;
            font-size: 13px;
        }
        
        .install-status.loading {
            background: #E3F2FD;
            color: #1565C0;
        }
        
        .install-status.success {
            background: #E8F5E9;
            color: #2E7D32;
        }
        
        .install-status.error {
            background: #FFEBEE;
            color: #C62828;
        }
        
        .radio-group {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        
        .radio-option {
            display: flex;
            align-items: flex-start;
            gap: 12px;
            padding: 15px;
            border: 2px solid #eee;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.2s;
        }
        
        .radio-option:hover {
            border-color: #ddd;
        }
        
        .radio-option.selected {
            border-color: #C01B1B;
            background: #FEF2F2;
        }
        
        .radio-option input[type="radio"] {
            margin-top: 3px;
            accent-color: #C01B1B;
        }
        
        .radio-content {
            flex: 1;
        }
        
        .radio-title {
            font-weight: 600;
            font-size: 15px;
            color: #1e1e1e;
            margin-bottom: 4px;
        }
        
        .radio-desc {
            font-size: 13px;
            color: #666;
        }
        
        .design-system-options {
            margin-top: 15px;
            padding: 15px;
            background: #f9f9f9;
            border-radius: 6px;
            display: none;
        }
        
        .design-system-options.visible {
            display: block;
        }
        
        .checkbox-group {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-top: 15px;
        }
        
        .checkbox-group input[type="checkbox"] {
            accent-color: #C01B1B;
            width: 18px;
            height: 18px;
        }
        
        .checkbox-group label {
            font-size: 14px;
            color: #1e1e1e;
            margin: 0;
        }
        
        .continue-section {
            text-align: center;
            padding-top: 10px;
        }
        
        .continue-section .btn {
            min-width: 200px;
        }
        
        .arrow-icon {
            margin-left: 8px;
        }
        
        #tokenStatus {
            display: none;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎨 Figma MCP Compiler</h1>
            <p>Convert Figma designs to pixel-perfect HTML/CSS/React</p>
        </div>
        
        <!-- How It Works -->
        <div class="card">
            <h2>How It Works</h2>
            <div class="how-it-works">
                <div class="step">
                    <div class="step-icon">📋</div>
                    <div class="step-title">1. Paste Figma URL</div>
                    <div class="step-desc">Link to any Figma frame or component</div>
                </div>
                <div class="step">
                    <div class="step-icon">⚙️</div>
                    <div class="step-title">2. Auto Translation</div>
                    <div class="step-desc">Auto Layout → CSS Flexbox</div>
                </div>
                <div class="step">
                    <div class="step-icon">🖥️</div>
                    <div class="step-title">3. Preview & Export</div>
                    <div class="step-desc">HTML, CSS, or React output</div>
                </div>
            </div>
            <div style="text-align: center;">
                <div class="no-ai-badge">
                    ✓ No AI code generation — deterministic rule-based translation
                </div>
            </div>
        </div>
        
        <!-- Figma Token -->
        <div class="card">
            <h2><span class="step-number">1</span> Figma Access Token</h2>
            <div class="form-group">
                <label>Personal Access Token</label>
                <div class="input-group">
                    <input type="password" id="figmaToken" placeholder="figd_xxxxxxxxxxxxxxxx">
                    <button class="btn btn-outline" onclick="toggleTokenVisibility()">👁️</button>
                    <button class="btn btn-secondary" onclick="validateToken()">Validate</button>
                </div>
                <div class="hint">
                    <a href="https://www.figma.com/developers/api#access-tokens" target="_blank">Get your token from Figma Settings →</a>
                </div>
                <div id="tokenStatus"></div>
            </div>
        </div>
        
        <!-- Output Mode -->
        <div class="card">
            <h2><span class="step-number">2</span> Output Mode</h2>
            <div class="radio-group">
                <label class="radio-option selected" onclick="selectMode('standard')">
                    <input type="radio" name="mode" value="standard" checked>
                    <div class="radio-content">
                        <div class="radio-title">Standard Mode</div>
                        <div class="radio-desc">Compile to plain HTML/CSS/React with inline styles</div>
                    </div>
                </label>
                <label class="radio-option" onclick="selectMode('designSystem')">
                    <input type="radio" name="mode" value="designSystem">
                    <div class="radio-content">
                        <div class="radio-title">Design System Mode</div>
                        <div class="radio-desc">Use your design system tokens and CSS variables</div>
                    </div>
                </label>
            </div>
            
            <div id="designSystemOptions" class="design-system-options">
                <div class="form-group">
                    <label>NPM Package Name *</label>
                    <input type="text" id="npmPackage" placeholder="rk-designsystem">
                    <div class="hint">The npm package name of your design system (will be installed locally)</div>
                </div>
                <div class="form-group">
                    <label>Design Tokens CSS URL (optional)</label>
                    <input type="url" id="tokensUrl" placeholder="https://example.com/design-tokens/theme.css">
                    <div class="hint">URL to your design system's CSS variables file</div>
                </div>
                <div class="form-group">
                    <label>Component CSS URL (optional)</label>
                    <input type="url" id="cssUrl" placeholder="https://example.com/designsystem/index.css">
                    <div class="hint">Additional CSS for component styles</div>
                </div>
                <div class="checkbox-group">
                    <input type="checkbox" id="codeConnectEnabled" checked>
                    <label for="codeConnectEnabled">Enable Code Connect (map Figma components to React)</label>
                </div>
                <div class="checkbox-group">
                    <input type="checkbox" id="reactPreviewEnabled">
                    <label for="reactPreviewEnabled">Enable React Preview (render actual React components)</label>
                </div>
                <div id="installStatus" class="install-status" style="display: none;"></div>
            </div>
        </div>
        
        <!-- Continue -->
        <div class="continue-section">
            <button class="btn btn-primary" onclick="saveAndContinue()">
                Save & Continue to Compiler <span class="arrow-icon">→</span>
            </button>
        </div>
    </div>
    
    <script>
        // Load saved config on page load
        document.addEventListener('DOMContentLoaded', () => {
            const config = JSON.parse(localStorage.getItem('figmaCompilerConfig') || '{}');
            
            if (config.figmaToken) {
                document.getElementById('figmaToken').value = config.figmaToken;
            }
            if (config.mode === 'designSystem') {
                selectMode('designSystem');
                document.querySelector('input[value="designSystem"]').checked = true;
            }
            if (config.designSystem) {
                if (config.designSystem.npmPackage) {
                    document.getElementById('npmPackage').value = config.designSystem.npmPackage;
                }
                if (config.designSystem.tokensUrl) {
                    document.getElementById('tokensUrl').value = config.designSystem.tokensUrl;
                }
                if (config.designSystem.cssUrl) {
                    document.getElementById('cssUrl').value = config.designSystem.cssUrl;
                }
                if (config.designSystem.codeConnectEnabled) {
                    document.getElementById('codeConnectEnabled').checked = true;
                }
                if (config.designSystem.reactPreviewEnabled) {
                    document.getElementById('reactPreviewEnabled').checked = true;
                }
            }
        });
        
        function toggleTokenVisibility() {
            const input = document.getElementById('figmaToken');
            input.type = input.type === 'password' ? 'text' : 'password';
        }
        
        async function validateToken() {
            const token = document.getElementById('figmaToken').value.trim();
            const statusEl = document.getElementById('tokenStatus');
            
            if (!token) {
                statusEl.style.display = 'block';
                statusEl.className = 'status-indicator status-error';
                statusEl.innerHTML = '✗ Please enter a token';
                return;
            }
            
            statusEl.style.display = 'block';
            statusEl.className = 'status-indicator status-pending';
            statusEl.innerHTML = '⏳ Validating...';
            
            try {
                const response = await fetch('/api/validate-token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token })
                });
                const data = await response.json();
                
                if (data.valid) {
                    statusEl.className = 'status-indicator status-success';
                    statusEl.innerHTML = '✓ Valid token for ' + data.user;
                } else {
                    statusEl.className = 'status-indicator status-error';
                    statusEl.innerHTML = '✗ Invalid token: ' + (data.error || 'Unknown error');
                }
            } catch (err) {
                statusEl.className = 'status-indicator status-error';
                statusEl.innerHTML = '✗ Connection error';
            }
        }
        
        function selectMode(mode) {
            const options = document.querySelectorAll('.radio-option');
            options.forEach(opt => opt.classList.remove('selected'));
            
            const selected = document.querySelector('input[value="' + mode + '"]');
            selected.checked = true;
            selected.closest('.radio-option').classList.add('selected');
            
            const dsOptions = document.getElementById('designSystemOptions');
            dsOptions.classList.toggle('visible', mode === 'designSystem');
        }
        
        async function saveAndContinue() {
            const token = document.getElementById('figmaToken').value.trim();
            
            if (!token) {
                alert('Please enter your Figma access token');
                return;
            }
            
            const mode = document.querySelector('input[name="mode"]:checked').value;
            const npmPackage = document.getElementById('npmPackage').value.trim();
            const reactPreviewEnabled = document.getElementById('reactPreviewEnabled').checked;
            
            // If design system mode with React preview, install the package first
            if (mode === 'designSystem' && npmPackage && reactPreviewEnabled) {
                const statusEl = document.getElementById('installStatus');
                statusEl.style.display = 'block';
                statusEl.className = 'install-status loading';
                statusEl.innerHTML = '📦 Installing ' + npmPackage + '... This may take a moment.';
                
                try {
                    const response = await fetch('/api/install-package', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ packageName: npmPackage })
                    });
                    const data = await response.json();
                    
                    if (!data.success) {
                        statusEl.className = 'install-status error';
                        statusEl.innerHTML = '❌ Failed to install: ' + data.error;
                        return;
                    }
                    
                    statusEl.className = 'install-status success';
                    statusEl.innerHTML = '✅ Package installed successfully!';
                } catch (err) {
                    statusEl.className = 'install-status error';
                    statusEl.innerHTML = '❌ Installation error: ' + err.message;
                    return;
                }
            }
            
            const config = {
                figmaToken: token,
                tokenValidated: true,
                mode: mode,
                designSystem: {
                    npmPackage: npmPackage,
                    tokensUrl: document.getElementById('tokensUrl').value.trim(),
                    cssUrl: document.getElementById('cssUrl').value.trim(),
                    codeConnectEnabled: document.getElementById('codeConnectEnabled').checked,
                    reactPreviewEnabled: reactPreviewEnabled
                }
            };
            
            localStorage.setItem('figmaCompilerConfig', JSON.stringify(config));
            window.location.href = '/compiler';
        }
    </script>
</body>
</html>`;
  }

  async start(port = 3000) {
    // Enable JSON body parsing
    this.app.use(express.json());
    
    // Serve node_modules statically for CSS/JS files
    const path = require('path');
    this.app.use('/node_modules', express.static(path.join(__dirname, 'node_modules')));
    
    // State for current compilation
    let currentUrl = null;
    let fileKey = null;
    let nodeId = null;
    let figmaData = null;

    // Setup page (landing page)
    this.app.get('/', (req, res) => {
      res.send(this.generateSetupPage());
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

    // Install npm package endpoint
    this.app.post('/api/install-package', async (req, res) => {
      const { packageName } = req.body;
      
      if (!packageName) {
        return res.json({ success: false, error: 'Package name required' });
      }
      
      // Validate package name (basic security check)
      if (!/^[@a-z0-9][-a-z0-9._]*$/i.test(packageName)) {
        return res.json({ success: false, error: 'Invalid package name' });
      }
      
      console.log(`📦 Installing npm package: ${packageName}`);
      
      try {
        const { exec } = require('child_process');
        const util = require('util');
        const execPromise = util.promisify(exec);
        
        // Install the package
        const { stdout, stderr } = await execPromise(`npm install ${packageName}`, {
          cwd: __dirname,
          timeout: 120000 // 2 minute timeout
        });
        
        console.log(`✅ Package installed: ${packageName}`);
        if (stdout) console.log(stdout);
        
        res.json({ success: true, message: `Package ${packageName} installed successfully` });
      } catch (err) {
        console.error(`❌ Failed to install ${packageName}:`, err.message);
        res.json({ success: false, error: err.message });
      }
    });

    // React preview bundle endpoint - serves bundled React components
    this.app.get('/api/react-bundle', async (req, res) => {
      try {
        const esbuild = require('esbuild');
        const fs = require('fs');
        const path = require('path');
        
        // Use stored component tree from the instance
        const componentTree = this.currentComponentTree || null;
        
        // Create a temporary entry file that imports the design system and renders components
        const entryCode = this.generateReactPreviewEntry(componentTree);
        const entryPath = path.join(__dirname, '.react-preview-entry.jsx');
        fs.writeFileSync(entryPath, entryCode);
        
        // Bundle with esbuild
        const result = await esbuild.build({
          entryPoints: [entryPath],
          bundle: true,
          write: false,
          format: 'iife',
          globalName: 'ReactPreview',
          jsx: 'automatic',
          jsxImportSource: 'react',
          external: [], // Bundle everything
          define: {
            'process.env.NODE_ENV': '"production"'
          },
          loader: {
            '.js': 'jsx',
            '.jsx': 'jsx',
            '.ts': 'tsx',
            '.tsx': 'tsx'
          }
        });
        
        // Clean up temp file
        fs.unlinkSync(entryPath);
        
        res.setHeader('Content-Type', 'application/javascript');
        res.send(result.outputFiles[0].text);
      } catch (err) {
        console.error('❌ React bundle error:', err);
        res.status(500).send(`console.error('Bundle error: ${err.message.replace(/'/g, "\\'")}');`);
      }
    });

    // React preview page - renders actual React components
    this.app.get('/react-preview', (req, res) => {
      res.send(this.generateReactPreviewPage(figmaData));
    });

    // Export HTML/CSS as deployable zip
    this.app.get('/api/export-html', (req, res) => {
      if (!figmaData) {
        return res.status(400).json({ error: 'No design loaded' });
      }
      try {
        const archiver = require('archiver');
        const nodeToRender = this.extractNodeToRender(figmaData);
        const renderedHTML = this.translateNodeToHTML(nodeToRender);
        const fileName = (figmaData.name || 'figma-export').replace(/[^a-zA-Z0-9-_]/g, '-');

        // Build a standalone HTML page
        const htmlPage = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${figmaData.name || 'Figma Export'}</title>
    <link href="https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@200;300;400;500;600;700;800;900&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="styles.css">
</head>
<body>
${renderedHTML}
</body>
</html>`;

        // Extract inline styles into a CSS file
        const cssRules = [];
        let classCounter = 0;
        let cleanHTML = htmlPage;
        cleanHTML = cleanHTML.replace(/style="([^"]*)"/g, (match, styleStr) => {
          const className = 'figma-style-' + (++classCounter);
          const cssProps = styleStr.split(';').filter(s => s.trim()).map(s => {
            const parts = s.split(':');
            const prop = parts[0]?.trim();
            const val = parts.slice(1).join(':')?.trim();
            return prop && val ? '  ' + prop + ': ' + val + ';' : '';
          }).filter(Boolean).join('\\n');
          if (cssProps) {
            cssRules.push('.' + className + ' {\\n' + cssProps + '\\n}');
          }
          return 'class="' + className + '"';
        });

        const cssContent = `/* Generated by Figma MCP Compiler */\n\n* { box-sizing: border-box; }\n\nbody {\n  font-family: 'Source Sans 3', sans-serif;\n  margin: 0;\n  padding: 0;\n}\n\n` + cssRules.join('\n\n');

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename="' + fileName + '-html.zip"');

        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.pipe(res);
        archive.append(cleanHTML, { name: 'index.html' });
        archive.append(cssContent, { name: 'styles.css' });
        archive.append('# ' + (figmaData.name || 'Figma Export') + '\\n\\nGenerated by Figma MCP Compiler.\\n\\n## Deploy\\n\\nServe the files with any static file server:\\n\\n```bash\\nnpx serve .\\n```\\n', { name: 'README.md' });
        archive.finalize();
      } catch (err) {
        console.error('❌ HTML export error:', err);
        res.status(500).json({ error: err.message });
      }
    });

    // Export React as deployable zip
    this.app.get('/api/export-react', async (req, res) => {
      if (!figmaData) {
        return res.status(400).json({ error: 'No design loaded' });
      }
      try {
        const archiver = require('archiver');
        const nodeToRender = this.extractNodeToRender(figmaData);
        const renderedHTML = this.translateNodeToHTML(nodeToRender);
        const fileName = (figmaData.name || 'figma-export').replace(/[^a-zA-Z0-9-_]/g, '-');
        const projectName = fileName.toLowerCase();

        // Generate React component code from HTML
        const { componentCode, cssModuleCode, imports } = this.generateReactComponentCode(renderedHTML);

        // package.json
        const packageJson = JSON.stringify({
          name: projectName,
          version: '1.0.0',
          private: true,
          scripts: {
            dev: 'vite',
            build: 'vite build',
            preview: 'vite preview'
          },
          dependencies: {
            'react': '^18.3.0',
            'react-dom': '^18.3.0',
            '@digdir/designsystemet-css': '^1.11.0',
            'rk-design-tokens': '^1.0.0',
            'rk-designsystem': '^1.0.0'
          },
          devDependencies: {
            '@vitejs/plugin-react': '^4.3.0',
            'vite': '^6.0.0'
          }
        }, null, 2);

        // vite.config.js
        const viteConfig = [
          "import { defineConfig } from 'vite';",
          "import react from '@vitejs/plugin-react';",
          "",
          "export default defineConfig({",
          "  plugins: [react()],",
          "});",
          ""
        ].join('\n');

        // index.html for Vite
        const projectTitle = figmaData.name || 'Figma Export';
        const indexHtml = [
          '<!DOCTYPE html>',
          '<html lang="en">',
          '<head>',
          '    <meta charset="UTF-8">',
          '    <meta name="viewport" content="width=device-width, initial-scale=1.0">',
          '    <title>' + projectTitle + '</title>',
          '    <link href="https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@200;300;400;500;600;700;800;900&display=swap" rel="stylesheet">',
          '</head>',
          '<body>',
          '    <div id="root"></div>',
          '    <script type="module" src="/src/main.jsx"><\/script>',
          '</body>',
          '</html>',
          ''
        ].join('\n');

        // main.jsx
        const mainJsx = [
          "import React from 'react';",
          "import ReactDOM from 'react-dom/client';",
          "import '@digdir/designsystemet-css';",
          "import 'rk-design-tokens/design-tokens-build/theme.css';",
          "import 'rk-designsystem/dist/rk-designsystem.css';",
          "import App from './App';",
          "",
          "ReactDOM.createRoot(document.getElementById('root')).render(",
          "  <React.StrictMode>",
          "    <App />",
          "  </React.StrictMode>",
          ");",
          ""
        ].join('\n');

        // App.jsx
        const appJsx = [
          "import React from 'react';",
          "import FigmaComponent from './components/FigmaComponent';",
          "",
          "export default function App() {",
          "  return <FigmaComponent />;",
          "}",
          ""
        ].join('\n');

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename="' + fileName + '-react.zip"');

        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.pipe(res);
        archive.append(packageJson, { name: 'package.json' });
        archive.append(viteConfig, { name: 'vite.config.js' });
        archive.append(indexHtml, { name: 'index.html' });
        archive.append(mainJsx, { name: 'src/main.jsx' });
        archive.append(appJsx, { name: 'src/App.jsx' });
        archive.append(componentCode, { name: 'src/components/FigmaComponent.jsx' });
        archive.append(cssModuleCode, { name: 'src/components/FigmaComponent.module.css' });
        archive.append('# ' + (figmaData.name || 'Figma Export') + '\\n\\nGenerated by Figma MCP Compiler.\\n\\n## Getting Started\\n\\n```bash\\nnpm install\\nnpm run dev\\n```\\n\\n## Build for Production\\n\\n```bash\\nnpm run build\\n```\\n\\nThe built files will be in the `dist` folder, ready to deploy.\\n', { name: 'README.md' });
        archive.finalize();
      } catch (err) {
        console.error('❌ React export error:', err);
        res.status(500).json({ error: err.message });
      }
    });

    // Compiler page
    this.app.get('/compiler', (req, res) => {
      if (!figmaData) {
        res.send(this.generateCompilerPage(null, ''));
      } else {
        res.send(this.generateCompilerPage(figmaData, currentUrl));
      }
    });

    // Load endpoint - load Figma URL with token from header
    this.app.post('/api/compile', async (req, res) => {
      try {
        const { url, token } = req.body;
        
        if (!url) {
          return res.status(400).json({ success: false, error: 'URL required' });
        }
        if (!token) {
          return res.status(400).json({ success: false, error: 'Token required' });
        }
        
        // Temporarily set the token for this request
        process.env.FIGMA_ACCESS_TOKEN = token;
        
        console.log('📂 Compile requested: ' + url);
        const parsed = this.parseFigmaUrl(url);
        fileKey = parsed.fileKey;
        nodeId = parsed.nodeId;
        currentUrl = url;
        
        figmaData = await this.fetchFigmaData(fileKey, nodeId);
        console.log('✅ Figma data compiled');
        
        res.json({ success: true, message: 'Compiled successfully', name: figmaData.name });
      } catch (err) {
        console.error('❌ Compile error:', err);
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Refresh endpoint
    this.app.post('/api/refresh', async (req, res) => {
      try {
        const { token } = req.body;
        
        if (!fileKey) {
          return res.status(400).json({ success: false, error: 'No design loaded' });
        }
        if (!token) {
          return res.status(400).json({ success: false, error: 'Token required' });
        }
        
        process.env.FIGMA_ACCESS_TOKEN = token;
        
        console.log('🔄 Refresh requested...');
        figmaData = await this.fetchFigmaData(fileKey, nodeId);
        console.log('✅ Figma data refreshed');
        
        res.json({ success: true, message: 'Refreshed successfully' });
      } catch (err) {
        console.error('❌ Refresh error:', err);
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Legacy endpoints for backward compatibility
    this.app.get('/refresh', async (req, res) => {
      if (!figmaData) {
        return res.status(400).json({ success: false, error: 'No design loaded' });
      }
      try {
        figmaData = await this.fetchFigmaData(fileKey, nodeId);
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
        
        const parsed = this.parseFigmaUrl(newUrl);
        fileKey = parsed.fileKey;
        nodeId = parsed.nodeId;
        currentUrl = newUrl;
        
        figmaData = await this.fetchFigmaData(fileKey, nodeId);
        res.json({ success: true, message: 'Figma data loaded', name: figmaData.name });
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

  // Generate compiler page HTML (updated version of generateHTML)
  generateCompilerPage(figmaData, currentUrl) {
    let renderedHTML = '<div style="text-align: center; padding: 60px; color: #888;"><p style="font-size: 48px; margin-bottom: 20px;">📋</p><p>Paste a Figma URL and click Load to preview your design</p></div>';
    
    if (figmaData) {
      // Build component tree for React hydration (same as generateReactPreviewPage)
      this.currentComponentTree = this.buildComponentTree(figmaData);
      
      // Extract specific node if we have nodes response
      let nodeToRender = this.extractNodeToRender(figmaData);
      renderedHTML = this.translateNodeToHTML(nodeToRender);
    }
    
    const fileName = figmaData?.name || 'No file loaded';
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Figma MCP Compiler</title>
    <link href="https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;500;600;700&display=swap" rel="stylesheet">
    <script src="https://unpkg.com/@lottiefiles/dotlottie-wc@latest/dist/dotlottie-wc.js" type="module"></script>
    <style>
        * {
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Source Sans 3', sans-serif;
            margin: 0;
            padding: 20px;
            background: #f5f5f5;
        }
        
        .container {
            max-width: 1400px;
            margin: 0 auto;
        }
        
        .header-title {
            font-size: 14px;
            font-weight: 600;
            color: #1e1e1e;
            margin: 0 0 20px 0;
            letter-spacing: 1px;
        }
        
        .toolbar {
            display: flex;
            align-items: center;
            gap: 15px;
            padding: 15px 20px;
            background: white;
            border-radius: 8px;
            margin-bottom: 20px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.08);
        }
        
        .settings-btn {
            background: none;
            border: none;
            cursor: pointer;
            padding: 8px;
            border-radius: 4px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .settings-btn:hover {
            background: #f5f5f5;
        }
        
        .settings-btn svg {
            width: 20px;
            height: 20px;
            color: #666;
        }
        
        .file-info {
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .refresh-btn {
            background: none;
            border: none;
            cursor: pointer;
            padding: 8px;
            border-radius: 4px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .refresh-btn:hover {
            background: #f5f5f5;
        }
        
        .refresh-btn svg {
            width: 18px;
            height: 18px;
            color: #666;
        }
        
        .refresh-btn.loading svg {
            animation: spin 1s linear infinite;
        }
        
        @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
        
        .file-name {
            font-size: 14px;
            color: #666;
        }
        
        .link-input-group {
            display: flex;
            flex: 1;
            gap: 10px;
        }
        
        .url-input {
            flex: 1;
            padding: 10px 14px;
            border: 1px solid #E0E0E0;
            border-radius: 4px;
            font-size: 14px;
            font-family: inherit;
            color: #666;
        }
        
        .url-input:focus {
            outline: none;
            border-color: #1e1e1e;
        }
        
        .load-button {
            display: flex;
            align-items: center;
            gap: 8px;
            background: #1e1e1e;
            color: white;
            border: none;
            padding: 10px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
        }
        
        .load-button:hover {
            background: #333;
        }
        
        .load-button:disabled {
            background: #ccc;
            cursor: not-allowed;
        }
        
        .load-button svg {
            width: 16px;
            height: 16px;
        }
        
        .output-toggle {
            display: flex;
            border-radius: 4px;
            overflow: hidden;
            border: 1px solid #C01B1B;
        }
        
        .toggle-btn {
            padding: 10px 16px;
            border: none;
            background: white;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            color: #1e1e1e;
            transition: all 0.2s;
        }
        
        .toggle-btn:not(:last-child) {
            border-right: 1px solid #C01B1B;
        }
        
        .toggle-btn.active {
            background: #C01B1B;
            color: white;
        }
        
        .toggle-btn:hover:not(.active) {
            background: #FEF2F2;
        }
        
        .react-preview-btn {
            background: #61dafb;
            color: #1e1e1e;
            border: none;
            padding: 10px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            margin-left: 10px;
        }
        
        .react-preview-btn:hover {
            background: #4fc3f7;
        }
        
        .divider {
            height: 1px;
            background: #E0E0E0;
            width: 100%;
        }
        
        .figma-output {
            background: white;
            border: 1px solid #E0E0E0;
            border-radius: 4px;
            padding: 20px;
            overflow-x: auto;
        }
        
        .code-output {
            background: #1e1e1e;
            color: #d4d4d4;
            padding: 15px;
            border-radius: 4px;
            font-family: 'Monaco', 'Menlo', monospace;
            font-size: 12px;
            overflow-x: auto;
            white-space: pre-wrap;
            max-height: 500px;
            overflow-y: auto;
        }
        
        .copy-btn {
            background: #333;
            color: white;
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            margin-bottom: 10px;
        }
        
        .copy-btn:hover {
            background: #444;
        }
        
        .error-message {
            color: #C01B1B;
            background: #FEF2F2;
            padding: 10px 15px;
            border-radius: 4px;
            margin-top: 10px;
            display: none;
        }
        
        .success-message {
            color: #27ae60;
            background: #f0fdf4;
            padding: 10px 15px;
            border-radius: 4px;
            margin-top: 10px;
            display: none;
        }
        
        h3 {
            margin: 0 0 10px 0;
            font-size: 16px;
            font-weight: 600;
        }
        
        h4 {
            margin: 15px 0 10px 0;
            font-size: 14px;
            font-weight: 600;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1 class="header-title">FIGMA MCP COMPILER</h1>
        
        <div class="toolbar">
            <button class="settings-btn" onclick="goToSettings()" title="Settings">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="3"/>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                </svg>
            </button>
            
            <div class="file-info">
                <button class="refresh-btn" onclick="refreshFromFigma()" title="Refresh" id="refreshBtn">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M1 4v6h6M23 20v-6h-6"/>
                        <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>
                    </svg>
                </button>
                <span class="file-name">File: ${fileName}</span>
            </div>
            
            <div class="link-input-group">
                <input type="text" class="url-input" id="figmaUrl" placeholder="Figma design link" value="${currentUrl || ''}">
                <button class="load-button" onclick="loadFromFigma()" id="loadBtn">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                        <line x1="8" y1="21" x2="16" y2="21"/>
                        <line x1="12" y1="17" x2="12" y2="21"/>
                    </svg>
                    Load
                </button>
            </div>
            
            <div class="output-toggle">
                <button class="toggle-btn" onclick="exportHTML()" id="btn-html">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="vertical-align: middle; margin-right: 4px;">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="7 10 12 15 17 10"/>
                        <line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                    HTML/CSS
                </button>
                <button class="toggle-btn" onclick="exportReact()" id="btn-react">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="vertical-align: middle; margin-right: 4px;">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="7 10 12 15 17 10"/>
                        <line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                    React
                </button>
            </div>
        </div>
        
        <div class="divider"></div>
        
        <div id="errorMsg" class="error-message"></div>
        <div id="successMsg" class="success-message"></div>
        
        <!-- React Preview (default) -->
        <div id="output-preview">
            <div class="figma-output preview-container">${renderedHTML}</div>
            <div class="hydration-status" id="hydrationStatus" style="position:fixed;bottom:20px;right:20px;background:#1e1e1e;color:white;padding:10px 16px;border-radius:6px;font-size:13px;z-index:1000;display:none;">⏳ Loading React...</div>
        </div>
    </div>
    
    <!-- Design System CSS for React preview -->
    <link rel="stylesheet" href="/node_modules/@digdir/designsystemet-css/dist/src/index.css">
    <link rel="stylesheet" href="/node_modules/rk-design-tokens/design-tokens-build/theme.css">
    <link rel="stylesheet" href="/node_modules/rk-designsystem/dist/rk-designsystem.css">
    
    <script>
        // Get config from localStorage
        function getConfig() {
            return JSON.parse(localStorage.getItem('figmaCompilerConfig') || '{}');
        }
        
        function goToSettings() {
            window.location.href = '/';
        }
        
        function exportHTML() {
            window.location.href = '/api/export-html';
        }
        
        function exportReact() {
            window.location.href = '/api/export-react';
        }
        
        async function loadFromFigma() {
            const url = document.getElementById('figmaUrl').value.trim();
            const config = getConfig();
            
            if (!url) {
                showError('Please enter a Figma URL');
                return;
            }
            
            if (!config.figmaToken) {
                showError('Please configure your Figma token in Settings');
                return;
            }
            
            const loadBtn = document.getElementById('loadBtn');
            loadBtn.disabled = true;
            loadBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation: spin 1s linear infinite;"><path d="M1 4v6h6M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg> Loading...';
            
            try {
                const response = await fetch('/api/compile', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url, token: config.figmaToken })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    showSuccess('Design loaded: ' + data.name);
                    setTimeout(() => window.location.reload(), 500);
                } else {
                    showError(data.error || 'Failed to load design');
                }
            } catch (err) {
                showError('Connection error: ' + err.message);
            } finally {
                loadBtn.disabled = false;
                loadBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> Load';
            }
        }
        
        async function refreshFromFigma() {
            const config = getConfig();
            
            if (!config.figmaToken) {
                showError('Please configure your Figma token in Settings');
                return;
            }
            
            const refreshBtn = document.getElementById('refreshBtn');
            refreshBtn.classList.add('loading');
            
            try {
                const response = await fetch('/api/refresh', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: config.figmaToken })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    showSuccess('Design refreshed');
                    setTimeout(() => window.location.reload(), 500);
                } else {
                    showError(data.error || 'Failed to refresh');
                }
            } catch (err) {
                showError('Connection error: ' + err.message);
            } finally {
                refreshBtn.classList.remove('loading');
            }
        }
        
        function showError(msg) {
            const el = document.getElementById('errorMsg');
            el.textContent = msg;
            el.style.display = 'block';
            document.getElementById('successMsg').style.display = 'none';
            setTimeout(() => el.style.display = 'none', 5000);
        }
        
        function showSuccess(msg) {
            const el = document.getElementById('successMsg');
            el.textContent = msg;
            el.style.display = 'block';
            document.getElementById('errorMsg').style.display = 'none';
            setTimeout(() => el.style.display = 'none', 3000);
        }
        
        // Check if config exists on load and hydrate React components
        document.addEventListener('DOMContentLoaded', () => {
            const config = getConfig();
            if (!config.figmaToken) {
                showError('No Figma token configured. Click the ⚙️ Settings button to set up.');
            }
            
            // Load React bundle to hydrate design system components
            const hasDesignContent = document.querySelector('[data-figma-id]');
            if (hasDesignContent) {
                const status = document.getElementById('hydrationStatus');
                if (status) status.style.display = 'block';
                
                const script = document.createElement('script');
                script.src = '/api/react-bundle';
                script.onload = () => {
                    if (status) {
                        status.innerHTML = '✅ React components hydrated';
                        setTimeout(() => { status.style.display = 'none'; }, 3000);
                    }
                };
                script.onerror = () => {
                    if (status) {
                        status.innerHTML = '❌ Failed to load React';
                        status.style.background = '#C62828';
                    }
                };
                document.body.appendChild(script);
            }
        });
    </script>
</body>
</html>`;
  }
}

// CLI usage
if (require.main === module) {
  const port = parseInt(process.argv[2]) || 3000;

  const compiler = new MCPCompiler();
  compiler.start(port);
}

module.exports = MCPCompiler;
