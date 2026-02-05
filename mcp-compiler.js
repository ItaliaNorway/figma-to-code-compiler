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
      
      // Fetch image URLs for vector/image nodes
      await this.fetchImageUrls(fileKey, figmaData);
      
      return figmaData;
    } catch (error) {
      console.error('❌ MCP Error:', error);
      throw error;
    }
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
              // Check if this node is named like a video
              const nodeInfo = this.findNodeById(nodeToScan, nodeId);
              const isVideoNode = nodeInfo && (
                nodeInfo.name.toLowerCase().includes('video') ||
                nodeInfo.name.toLowerCase().includes('.mp4') ||
                nodeInfo.name.toLowerCase().includes('.webm') ||
                nodeInfo.name.toLowerCase().includes('.mov')
              );
              
              if (isVideoNode) {
                // For video nodes, we need to check if there's a video asset
                const imageFill = nodeInfo.fills?.find(f => f.type === 'IMAGE' && f.visible !== false);
                if (imageFill?.imageRef) {
                  console.log(`   Checking video asset for imageRef: ${imageFill.imageRef}`);
                  // Check if the asset URL contains video indicators
                  const assetUrl = fileAssets[imageFill.imageRef];
                  if (assetUrl) {
                    console.log(`   Asset URL: ${assetUrl.substring(0, 100)}...`);
                  }
                }
                // For now, store as video placeholder - we'll need the actual video URL
                // Figma stores video thumbnails as images, actual video needs different approach
                this.videoUrls[nodeId] = url; // Use thumbnail for now
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
      // Log all fill types for debugging
      const fillTypes = node.fills.map(f => f.type).join(', ');
      if (node.fills.length > 0 && (node.fills.some(f => f.type === 'IMAGE' || f.type === 'VIDEO'))) {
        console.log(`     Fill types for ${node.name}: [${fillTypes}]`);
      }
      
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
  
  hasVideoFill(node) {
    // Check for explicit VIDEO fill or if we have a video URL for this node
    return node.fills?.some(f => f.type === 'VIDEO' && f.visible !== false) || 
           this.videoUrls[node.id] !== undefined;
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
        const alignMap = { 'MIN': 'flex-start', 'CENTER': 'center', 'MAX': 'flex-end', 'SPACE_BETWEEN': 'space-between' };
        styles.push(`justify-content: ${alignMap[node.primaryAxisAlignItems] || 'flex-start'}`);
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
        const frameStyle = this.translateAutoLayoutToCSS(node);
        const children = node.children ? 
          node.children.map(child => this.translateNodeToHTML(child, depth + 1, nodeHasAutoLayout)).join('\n') : '';
        
        html = `${indent}<div class="${className}" data-figma-id="${node.id}" style="${frameStyle}">
${children}
${indent}</div>`;
        break;
        
      case 'RECTANGLE':
        // Check if this rectangle has a video fill
        if (this.hasVideoFill(node)) {
          const videoUrl = this.getVideoUrl(node.id);
          const videoStyle = this.translateVideoStyle(node, parentHasAutoLayout);
          // Render as a video container with poster/thumbnail
          // Note: Figma API only provides thumbnails, not actual video URLs
          // The actual video URL would need to be provided separately or via MCP local server
          html = `${indent}<div class="${className} video-container" data-figma-id="${node.id}" data-video-name="${node.name}" style="${videoStyle}; background-image: url('${videoUrl}'); background-size: cover; background-position: center; position: relative;">
${indent}  <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 48px; height: 48px; background: rgba(0,0,0,0.6); border-radius: 50%; display: flex; align-items: center; justify-content: center;">
${indent}    <svg width="24" height="24" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
${indent}  </div>
${indent}</div>`;
        } else {
          const rectStyle = this.translateRectangleStyle(node, parentHasAutoLayout);
          html = `${indent}<div class="${className}" data-figma-id="${node.id}" style="${rectStyle}"></div>`;
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
        const instanceStyle = this.translateAutoLayoutToCSS(node);
        if (node.children && node.children.length > 0) {
          const instanceChildren = node.children.map(child => this.translateNodeToHTML(child, depth + 1, nodeHasAutoLayout)).join('\n');
          html = `${indent}<div class="${className}" data-figma-id="${node.id}" style="${instanceStyle}">
${instanceChildren}
${indent}</div>`;
        } else {
          const instanceUrl = this.getImageUrl(node.id);
          if (instanceUrl) {
            html = `${indent}<img class="${className}" data-figma-id="${node.id}" src="${instanceUrl}" alt="${node.name}" style="${instanceStyle}" />`;
          } else {
            html = `${indent}<div class="${className}" data-figma-id="${node.id}" style="${instanceStyle}"></div>`;
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
    
    // Font properties from node.style
    if (node.style) {
      if (node.style.fontFamily) styles.push(`font-family: '${node.style.fontFamily}', sans-serif`);
      if (node.style.fontSize) styles.push(`font-size: ${this.round(node.style.fontSize)}px`);
      if (node.style.fontWeight) styles.push(`font-weight: ${node.style.fontWeight}`);
      
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
      
      // Line height
      if (node.style.lineHeightPx) styles.push(`line-height: ${node.style.lineHeightPx}px`);
      else if (node.style.lineHeightPercent) styles.push(`line-height: ${node.style.lineHeightPercent}%`);
      else if (node.style.lineHeightPercentFontSize) styles.push(`line-height: ${node.style.lineHeightPercentFontSize}%`);
    }
    
    // Text color
    if (node.fills && node.fills.length > 0) {
      const fill = node.fills.find(f => f.type === 'SOLID' && f.visible !== false);
      if (fill && fill.color) {
        const r = Math.round(fill.color.r * 255);
        const g = Math.round(fill.color.g * 255);
        const b = Math.round(fill.color.b * 255);
        const a = fill.opacity !== undefined ? fill.opacity : 1;
        styles.push(`color: rgba(${r}, ${g}, ${b}, ${a})`);
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
    <title>Figma MCP Compiler</title>
    <style>
        body {
            margin: 0;
            padding: 20px;
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background-color: #f5f5f5;
        }
        
        .container {
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            padding: 20px;
            margin-bottom: 20px;
        }
        
        .figma-output {
            background: white;
            border: 1px solid #ddd;
            border-radius: 4px;
            padding: 20px;
            overflow-x: auto;
        }
        
        .url-input-group {
            display: flex;
            gap: 10px;
            margin-bottom: 15px;
            flex-wrap: wrap;
        }
        
        .url-input {
            flex: 1;
            min-width: 300px;
            padding: 10px 15px;
            border: 1px solid #ddd;
            border-radius: 6px;
            font-size: 14px;
            font-family: inherit;
        }
        
        .url-input:focus {
            outline: none;
            border-color: #0d99ff;
        }
        
        .load-button, .refresh-button {
            background: #0d99ff;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
        }
        
        .load-button:hover, .refresh-button:hover {
            background: #0b7fe0;
        }
        
        .refresh-button {
            margin-bottom: 10px;
        }
        
        .info {
            color: #666;
            font-size: 14px;
            margin-bottom: 10px;
        }
        
        .error-message {
            color: #e74c3c;
            background: #fdf2f2;
            padding: 10px 15px;
            border-radius: 6px;
            margin-top: 10px;
            display: none;
        }
        
        .success-message {
            color: #27ae60;
            background: #f0fdf4;
            padding: 10px 15px;
            border-radius: 6px;
            margin-top: 10px;
            display: none;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Figma MCP Compiler</h1>
        
        <div class="url-input-group">
            <input type="text" class="url-input" id="figmaUrl" placeholder="Paste Figma URL here..." value="${currentUrl}">
            <button class="load-button" onclick="loadFromFigma()">📂 Load</button>
        </div>
        
        <div class="info">File: ${figmaData.name || 'Untitled'}</div>
        <button class="refresh-button" onclick="refreshFromFigma()">🔄 Refresh</button>
        <div class="info">Auto Layout → CSS Flexbox Translation</div>
        
        <div id="errorMsg" class="error-message"></div>
        <div id="successMsg" class="success-message"></div>
        
        <h3>Rendered Design:</h3>
        <div class="figma-output">${renderedHTML}</div>
    </div>
    
    <script>
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
            const button = document.querySelector('.refresh-button');
            const errorMsg = document.getElementById('errorMsg');
            const successMsg = document.getElementById('successMsg');
            
            button.disabled = true;
            button.textContent = '🔄 Syncing...';
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
                    button.textContent = '🔄 Refresh';
                }
            } catch (error) {
                errorMsg.textContent = 'Refresh failed: ' + error.message;
                errorMsg.style.display = 'block';
                button.disabled = false;
                button.textContent = '🔄 Refresh';
            }
        }
        
        // Allow Enter key to load
        document.getElementById('figmaUrl').addEventListener('keypress', function(e) {
            if (e.key === 'Enter') loadFromFigma();
        });
    </script>
</body>
</html>`;
  }

  async start(figmaUrl, port = 3000) {
    try {
      let currentUrl = figmaUrl;
      let { fileKey, nodeId } = this.parseFigmaUrl(figmaUrl);
      console.log(`📁 Fetching Figma data via MCP: ${fileKey}${nodeId ? ` (node: ${nodeId})` : ''}`);
      
      let figmaData = await this.fetchFigmaData(fileKey, nodeId);
      console.log('✅ Figma data loaded via MCP');

      // Serve the compiled HTML
      this.app.get('/', (req, res) => {
        res.send(this.generateHTML(figmaData, currentUrl));
      });

      // Refresh endpoint - re-fetch Figma data
      this.app.get('/refresh', async (req, res) => {
        try {
          console.log('🔄 Refresh requested - fetching latest Figma data...');
          figmaData = await this.fetchFigmaData(fileKey, nodeId);
          console.log('✅ Figma data refreshed');
          res.json({ success: true, message: 'Figma data refreshed' });
        } catch (err) {
          console.error('❌ Refresh error:', err);
          res.status(500).json({ success: false, error: err.message });
        }
      });

      // Load endpoint - load new Figma URL
      this.app.get('/load', async (req, res) => {
        try {
          const newUrl = req.query.url;
          if (!newUrl) {
            return res.status(400).json({ success: false, error: 'URL parameter required' });
          }
          
          console.log(`📂 Load requested: ${newUrl}`);
          const parsed = this.parseFigmaUrl(newUrl);
          fileKey = parsed.fileKey;
          nodeId = parsed.nodeId;
          currentUrl = newUrl;
          
          figmaData = await this.fetchFigmaData(fileKey, nodeId);
          console.log('✅ New Figma data loaded');
          res.json({ success: true, message: 'Figma data loaded', name: figmaData.name });
        } catch (err) {
          console.error('❌ Load error:', err);
          res.status(500).json({ success: false, error: err.message });
        }
      });

      this.server = createServer(this.app);
      this.server.listen(port, () => {
        console.log(`🌐 Server running at http://localhost:${port}`);
        console.log('🎨 Figma data translated to HTML/CSS!');
        console.log('📋 Auto Layout properties converted to CSS Flexbox');
      });

    } catch (error) {
      console.error('❌ Error:', error.message);
      process.exit(1);
    }
  }
}

// CLI usage
if (require.main === module) {
  const figmaUrl = process.argv[2];
  const port = parseInt(process.argv[3]) || 3000;

  if (!figmaUrl) {
    console.log('Usage: node mcp-compiler.js <figma-url> [port]');
    console.log('Example: node mcp-compiler.js "https://www.figma.com/design/..." 3000');
    process.exit(1);
  }

  const compiler = new MCPCompiler();
  compiler.start(figmaUrl, port);
}

module.exports = MCPCompiler;
