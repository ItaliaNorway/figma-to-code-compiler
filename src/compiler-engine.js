/**
 * Figma to HTML/CSS Compiler Engine
 * Core translation logic - converts Figma nodes to HTML/CSS
 */

const FigmaMCPClient = require('../mcp-client');

class CompilerEngine {
  constructor() {
    this.mcpClient = new FigmaMCPClient();
    this.imageUrls = {};
    this.svgContent = {};
    this.videoUrls = {};
    this.gifUrls = {};
    this.codeConnectMap = {};
    this.variableDefinitions = {};
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

  async fetchVariableDefinitions(fileKey, figmaData) {
    const token = process.env.FIGMA_ACCESS_TOKEN;
    if (!token) return;
    
    // Collect bound variable IDs from the node tree
    const boundVariableIds = new Set();
    
    const collectBoundVariables = (node) => {
      if (!node) return;
      if (node.boundVariables) {
        Object.values(node.boundVariables).forEach(binding => {
          if (binding?.id) boundVariableIds.add(binding.id);
          if (Array.isArray(binding)) {
            binding.forEach(b => { if (b?.id) boundVariableIds.add(b.id); });
          }
        });
      }
      if (node.children) {
        node.children.forEach(child => collectBoundVariables(child));
      }
    };
    
    // Extract node to scan
    let nodeToScan = figmaData;
    if (figmaData.nodes) {
      const firstNodeKey = Object.keys(figmaData.nodes)[0];
      if (firstNodeKey) nodeToScan = figmaData.nodes[firstNodeKey].document;
    }
    collectBoundVariables(nodeToScan);
    
    if (boundVariableIds.size === 0) return;
    
    console.log(`🎨 Found ${boundVariableIds.size} bound variables, fetching definitions...`);
    
    try {
      const result = await this.mcpClient.getVariableDefinitions(fileKey, nodeToScan.id);
      if (result && typeof result === 'object') {
        this.variableDefinitions = result;
        console.log(`🎨 Loaded ${Object.keys(result).length} design tokens via MCP`);
      }
    } catch (error) {
      console.warn('⚠️  Could not fetch variable definitions:', error.message);
    }
  }

  async fetchCodeConnectMappings(fileKey, nodeId, figmaData) {
    const token = process.env.FIGMA_ACCESS_TOKEN;
    if (!token) return;
    
    this.codeConnectMap = {};
    
    let nodeToScan = figmaData;
    if (figmaData.nodes) {
      const firstNodeKey = Object.keys(figmaData.nodes)[0];
      if (firstNodeKey) nodeToScan = figmaData.nodes[firstNodeKey].document;
    }
    
    const componentNodeIds = [];
    this.collectComponentNodes(nodeToScan, componentNodeIds);
    
    if (componentNodeIds.length === 0) return;
    
    console.log(`🔗 Checking Code Connect for ${componentNodeIds.length} potential components...`);
    
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
              const componentId = nodeData.componentId;
              const mainComponentId = nodeData.mainComponent?.id;
              
              if (componentId || mainComponentId) {
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
    
    if (node.type === 'INSTANCE' || node.componentId) {
      componentNodeIds.push(node.id);
    }
    
    if (node.children && depth < 10) {
      for (const child of node.children) {
        this.collectComponentNodes(child, componentNodeIds, depth + 1);
      }
    }
  }

  extractComponentName(nodeData) {
    if (!nodeData) return null;
    let name = nodeData.name || '';
    name = name.split('/').pop();
    name = name.replace(/[^a-zA-Z0-9]/g, '');
    if (name && /^[A-Z]/.test(name)) {
      return name;
    }
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  extractComponentProps(nodeData) {
    const props = {};
    if (nodeData.componentProperties) {
      for (const [key, value] of Object.entries(nodeData.componentProperties)) {
        props[key] = value.value;
      }
    }
    return props;
  }

  async fetchImageUrls(fileKey, figmaData) {
    const token = process.env.FIGMA_ACCESS_TOKEN;
    if (!token) return;

    let nodeToScan = figmaData;
    if (figmaData.nodes) {
      const firstNodeKey = Object.keys(figmaData.nodes)[0];
      if (firstNodeKey) nodeToScan = figmaData.nodes[firstNodeKey].document;
    }

    const vectorNodeIds = [];
    const imageNodeIds = [];
    const allNodes = {};
    
    const scanNode = (node) => {
      if (!node) return;
      if (node.visible === false) return;
      
      allNodes[node.id] = node;
      
      const vectorTypes = ['VECTOR', 'BOOLEAN_OPERATION', 'LINE', 'REGULAR_POLYGON', 'STAR'];
      if (vectorTypes.includes(node.type)) {
        vectorNodeIds.push(node.id);
        console.log(`  📷 Found ${node.type}: ${node.name} (${node.id})`);
      }
      
      if (node.fills) {
        const hasImageFill = node.fills.some(f => f.type === 'IMAGE' && f.visible !== false);
        if (hasImageFill) {
          imageNodeIds.push(node.id);
          console.log(`  🖼️  Found IMAGE fill: ${node.name} (${node.id})`);
        }
      }
      
      if (node.children) {
        node.children.forEach(child => scanNode(child));
      }
    };

    console.log('🔍 Scanning for image/vector/video nodes...');
    scanNode(nodeToScan);

    // Fetch SVGs for vector nodes
    if (vectorNodeIds.length > 0) {
      console.log(`🖼️  Fetching SVG for ${vectorNodeIds.length} vector nodes...`);
      try {
        const svgResponse = await fetch(
          `https://api.figma.com/v1/images/${fileKey}?ids=${vectorNodeIds.join(',')}&format=svg`,
          { headers: { 'X-Figma-Token': token } }
        );
        
        if (svgResponse.ok) {
          const svgData = await svgResponse.json();
          if (svgData.images) {
            for (const [nodeId, svgUrl] of Object.entries(svgData.images)) {
              if (svgUrl) {
                try {
                  const svgFetch = await fetch(svgUrl);
                  if (svgFetch.ok) {
                    const svgText = await svgFetch.text();
                    this.svgContent[nodeId] = svgText;
                    console.log(`  ✅ Fetched SVG for ${nodeId}`);
                  }
                } catch (err) {
                  console.log(`  ⚠️  Could not fetch SVG content for ${nodeId}`);
                }
              }
            }
          }
        }
      } catch (error) {
        console.warn('⚠️  Error fetching SVGs:', error.message);
      }
    }

    // Fetch file assets for images
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
      }
    } catch (error) {
      console.warn('⚠️  Could not fetch file assets');
    }

    // Fetch PNGs for image nodes
    if (imageNodeIds.length > 0) {
      console.log(`🖼️  Fetching PNG for ${imageNodeIds.length} image nodes...`);
      try {
        const pngResponse = await fetch(
          `https://api.figma.com/v1/images/${fileKey}?ids=${imageNodeIds.join(',')}&format=png&scale=2`,
          { headers: { 'X-Figma-Token': token } }
        );
        
        if (pngResponse.ok) {
          const pngData = await pngResponse.json();
          if (pngData.images) {
            for (const [nodeId, url] of Object.entries(pngData.images)) {
              if (url) {
                const nodeInfo = allNodes[nodeId];
                const nodeName = nodeInfo?.name?.toLowerCase() || '';
                const isGifNode = nodeName.includes('.gif') || nodeName.includes('gif');
                const isVideoNode = !isGifNode && (
                  nodeName.includes('video') ||
                  nodeName.includes('.mp4') ||
                  nodeName.includes('.webm') ||
                  nodeName.includes('.mov')
                );
                const imageFill = nodeInfo?.fills?.find(f => f.type === 'IMAGE' && f.visible !== false);
                const originalAssetUrl = imageFill?.imageRef ? fileAssets[imageFill.imageRef] : null;
                
                if (isGifNode) {
                  this.gifUrls[nodeId] = originalAssetUrl || url;
                  console.log(`  🎞️  Detected GIF node: ${nodeId}`);
                } else if (isVideoNode) {
                  this.videoUrls[nodeId] = url;
                  console.log(`  🎬 Detected video node: ${nodeId}`);
                } else {
                  this.imageUrls[nodeId] = url;
                  console.log(`  ✅ Got image URL for ${nodeId}`);
                }
              }
            }
          }
        }
      } catch (error) {
        console.warn('⚠️  Error fetching images:', error.message);
      }
    }

    console.log(`✅ Fetched ${Object.keys(this.svgContent).length} inline SVGs, ${Object.keys(this.imageUrls).length} image URLs, ${Object.keys(this.videoUrls).length} video URLs`);
  }

  // Helper methods
  getImageUrl(nodeId) { return this.imageUrls[nodeId] || null; }
  getSvgContent(nodeId) { return this.svgContent[nodeId] || null; }
  getVideoUrl(nodeId) { return this.videoUrls[nodeId] || null; }
  getGifUrl(nodeId) { return this.gifUrls?.[nodeId] || null; }
  hasGifFill(node) { return this.gifUrls?.[node.id] !== undefined; }

  getLottieUrl(node) {
    if (!node.name) return null;
    const directMatch = node.name.match(/https:\/\/(?:assets\d*\.lottiefiles\.com|lottie\.host)\/[^\s]+\.(?:json|lottie)/i);
    if (directMatch) return directMatch[0];
    const appMatch = node.name.match(/https:\/\/app\.lottiefiles\.com\/[^\s]+/i);
    if (appMatch) {
      console.log(`  ⚠️  Lottie app URL detected. For animation to work, use the direct JSON/lottie URL from LottieFiles.`);
      return appMatch[0];
    }
    return null;
  }

  isDirectLottieUrl(url) {
    return url && (url.endsWith('.json') || url.endsWith('.lottie'));
  }

  hasLottieFill(node) {
    return this.getLottieUrl(node) !== null;
  }

  round(value) {
    return Math.round(value * 10) / 10;
  }

  getClassName(name) {
    if (!name) return 'element';
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'element';
  }

  getBoundVariableValue(node, property, fallbackValue) {
    if (!node.boundVariables || !node.boundVariables[property]) {
      return fallbackValue;
    }
    
    const binding = node.boundVariables[property];
    const variableId = binding?.id || (Array.isArray(binding) && binding[0]?.id);
    
    if (!variableId) return fallbackValue;
    
    const varDef = this.variableDefinitions[variableId];
    if (varDef && varDef.name) {
      const cssVarName = '--' + varDef.name.replace(/\//g, '-').replace(/\s+/g, '-').toLowerCase();
      return `var(${cssVarName}, ${fallbackValue})`;
    }
    
    return fallbackValue;
  }

  rgbaToHex(r, g, b, a = 1) {
    const toHex = (n) => {
      const hex = Math.round(n * 255).toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    };
    if (a < 1) {
      return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a.toFixed(2)})`;
    }
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  translateFillToCSS(fill) {
    if (!fill || fill.visible === false) return null;
    
    if (fill.type === 'SOLID') {
      const { r, g, b } = fill.color;
      const a = fill.opacity ?? 1;
      return this.rgbaToHex(r, g, b, a);
    }
    
    if (fill.type === 'GRADIENT_LINEAR') {
      const stops = fill.gradientStops.map(stop => {
        const { r, g, b } = stop.color;
        const a = stop.color.a ?? 1;
        const color = this.rgbaToHex(r, g, b, a);
        return `${color} ${Math.round(stop.position * 100)}%`;
      }).join(', ');
      
      const handles = fill.gradientHandlePositions;
      if (handles && handles.length >= 2) {
        const dx = handles[1].x - handles[0].x;
        const dy = handles[1].y - handles[0].y;
        const angle = Math.round(Math.atan2(dy, dx) * 180 / Math.PI + 90);
        return `linear-gradient(${angle}deg, ${stops})`;
      }
      return `linear-gradient(180deg, ${stops})`;
    }
    
    if (fill.type === 'GRADIENT_RADIAL') {
      const stops = fill.gradientStops.map(stop => {
        const { r, g, b } = stop.color;
        const a = stop.color.a ?? 1;
        const color = this.rgbaToHex(r, g, b, a);
        return `${color} ${Math.round(stop.position * 100)}%`;
      }).join(', ');
      return `radial-gradient(circle, ${stops})`;
    }
    
    return null;
  }

  applyEffect(effect) {
    if (!effect || effect.visible === false) return null;
    
    if (effect.type === 'DROP_SHADOW') {
      const { r, g, b, a } = effect.color;
      const color = this.rgbaToHex(r, g, b, a);
      const x = this.round(effect.offset?.x || 0);
      const y = this.round(effect.offset?.y || 0);
      const blur = this.round(effect.radius || 0);
      const spread = this.round(effect.spread || 0);
      return `box-shadow: ${x}px ${y}px ${blur}px ${spread}px ${color}`;
    }
    
    if (effect.type === 'INNER_SHADOW') {
      const { r, g, b, a } = effect.color;
      const color = this.rgbaToHex(r, g, b, a);
      const x = this.round(effect.offset?.x || 0);
      const y = this.round(effect.offset?.y || 0);
      const blur = this.round(effect.radius || 0);
      return `box-shadow: inset ${x}px ${y}px ${blur}px ${color}`;
    }
    
    if (effect.type === 'LAYER_BLUR') {
      return `filter: blur(${this.round(effect.radius)}px)`;
    }
    
    if (effect.type === 'BACKGROUND_BLUR') {
      return `backdrop-filter: blur(${this.round(effect.radius)}px)`;
    }
    
    return null;
  }

  translateAutoLayoutToCSS(node) {
    const styles = [];
    const bbox = node.absoluteBoundingBox;
    
    // Size handling
    if (node.layoutSizingHorizontal === 'FILL') {
      styles.push('flex: 1');
    } else if (node.layoutSizingHorizontal === 'HUG') {
      styles.push('width: auto');
    } else if (bbox) {
      styles.push(`width: ${this.round(bbox.width)}px`);
    }
    
    if (node.layoutSizingVertical === 'FILL') {
      styles.push('align-self: stretch');
    } else if (node.layoutSizingVertical === 'HUG') {
      styles.push('height: auto');
    } else if (bbox) {
      styles.push(`height: ${this.round(bbox.height)}px`);
    }
    
    // Min/max constraints
    if (node.minWidth) styles.push(`min-width: ${this.round(node.minWidth)}px`);
    if (node.maxWidth) styles.push(`max-width: ${this.round(node.maxWidth)}px`);
    if (node.minHeight) styles.push(`min-height: ${this.round(node.minHeight)}px`);
    if (node.maxHeight) styles.push(`max-height: ${this.round(node.maxHeight)}px`);
    
    // Background
    if (node.fills && node.fills.length > 0) {
      const visibleFills = node.fills.filter(f => f.visible !== false);
      if (visibleFills.length > 0) {
        const fill = visibleFills[0];
        const fillCSS = this.translateFillToCSS(fill);
        if (fillCSS) {
          if (fillCSS.includes('gradient')) {
            styles.push(`background: ${fillCSS}`);
          } else {
            styles.push(`background-color: ${fillCSS}`);
          }
        }
      }
    }
    
    // Border radius
    if (node.cornerRadius) {
      styles.push(`border-radius: ${this.round(node.cornerRadius)}px`);
    } else if (node.rectangleCornerRadii) {
      const [tl, tr, br, bl] = node.rectangleCornerRadii;
      styles.push(`border-radius: ${this.round(tl)}px ${this.round(tr)}px ${this.round(br)}px ${this.round(bl)}px`);
    }
    
    // Strokes
    if (node.strokes && node.strokes.length > 0) {
      const stroke = node.strokes.find(s => s.visible !== false);
      if (stroke) {
        const strokeColor = this.translateFillToCSS(stroke);
        const strokeWeight = node.strokeWeight || 1;
        if (strokeColor && !strokeColor.includes('gradient')) {
          styles.push(`border: ${this.round(strokeWeight)}px solid ${strokeColor}`);
        }
      }
    }
    
    // Opacity
    if (node.opacity !== undefined && node.opacity < 1) {
      styles.push(`opacity: ${node.opacity.toFixed(2)}`);
    }
    
    // Overflow
    if (node.clipsContent) {
      styles.push('overflow: hidden');
    }
    
    // Background color from node
    if (node.backgroundColor) {
      const { r, g, b } = node.backgroundColor;
      const a = node.backgroundColor.a ?? 1;
      styles.push(`background-color: rgba(${r}, ${g}, ${b}, ${a})`);
    }
    
    if (node.layoutMode) {
      styles.push('display: flex');
      styles.push(`flex-direction: ${node.layoutMode === 'VERTICAL' ? 'column' : 'row'}`);
      
      // Primary axis alignment
      if (node.primaryAxisAlignItems) {
        let justifyContent = node.primaryAxisAlignItems;
        // If SPACE_BETWEEN but only 1 child, use center instead
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
      
      // Gap
      if (node.itemSpacing !== undefined) styles.push(`gap: ${node.itemSpacing}px`);
      
      // Padding
      const pt = node.paddingTop || 0;
      const pr = node.paddingRight || 0;
      const pb = node.paddingBottom || 0;
      const pl = node.paddingLeft || 0;
      if (pt || pr || pb || pl) styles.push(`padding: ${pt}px ${pr}px ${pb}px ${pl}px`);
    }
    
    // Effects
    if (node.effects && node.effects.length > 0) {
      const effectCSS = node.effects.map(e => this.applyEffect(e)).filter(Boolean);
      styles.push(...effectCSS);
    }
    
    return styles.join('; ');
  }

  translateTextStyle(node, parentHasAutoLayout = false) {
    const styles = [];
    styles.push('margin: 0');
    
    // Size handling for text
    if (node.layoutSizingHorizontal === 'FILL') {
      styles.push('flex: 1');
    } else if (node.layoutSizingHorizontal === 'HUG') {
      styles.push('width: auto');
    }
    
    if (node.layoutSizingVertical === 'FILL') {
      styles.push('align-self: stretch');
    }
    
    // Font family with design token support
    let fontFamily = node.style?.fontFamily || 'sans-serif';
    const fontFamilyValue = `"${fontFamily}", sans-serif`;
    const fontFamilyCSS = this.getBoundVariableValue(node, 'fontFamily', fontFamilyValue);
    styles.push(`font-family: ${fontFamilyCSS}`);
    
    // Font size with design token support
    const fontSize = node.style?.fontSize || 16;
    const fontSizeValue = `${fontSize}px`;
    const fontSizeCSS = this.getBoundVariableValue(node, 'fontSize', fontSizeValue);
    styles.push(`font-size: ${fontSizeCSS}`);
    
    // Font weight
    const fontWeight = node.style?.fontWeight || 400;
    styles.push(`font-weight: ${fontWeight}`);
    
    // Italic
    if (node.style?.italic) {
      styles.push('font-style: italic');
    }
    
    // Text decoration
    if (node.style?.textDecoration === 'UNDERLINE') {
      styles.push('text-decoration: underline');
    } else if (node.style?.textDecoration === 'STRIKETHROUGH') {
      styles.push('text-decoration: line-through');
    }
    
    // Text alignment
    const alignMap = { 'LEFT': 'left', 'CENTER': 'center', 'RIGHT': 'right', 'JUSTIFIED': 'justify' };
    const textAlign = alignMap[node.style?.textAlignHorizontal] || 'left';
    styles.push(`text-align: ${textAlign}`);
    
    // Line height
    if (node.style?.lineHeightPercentFontSize) {
      styles.push(`line-height: ${node.style.lineHeightPercentFontSize}%`);
    } else if (node.style?.lineHeightPx) {
      styles.push(`line-height: ${this.round(node.style.lineHeightPx)}px`);
    }
    
    // Letter spacing
    if (node.style?.letterSpacing) {
      styles.push(`letter-spacing: ${this.round(node.style.letterSpacing)}px`);
    }
    
    // Text color with design token support
    if (node.fills && node.fills.length > 0) {
      const fill = node.fills.find(f => f.visible !== false && f.type === 'SOLID');
      if (fill) {
        const { r, g, b } = fill.color;
        const a = fill.opacity ?? fill.color.a ?? 1;
        const colorValue = this.rgbaToHex(r, g, b, a);
        const colorCSS = this.getBoundVariableValue(node, 'fills', colorValue);
        styles.push(`color: ${colorCSS}`);
      }
    }
    
    return styles.join('; ');
  }

  translateVideoStyle(node, parentHasAutoLayout = false) {
    const styles = [];
    const bbox = node.absoluteBoundingBox;
    
    if (bbox) {
      styles.push(`width: ${this.round(bbox.width)}px`);
      styles.push(`height: ${this.round(bbox.height)}px`);
    }
    
    if (node.cornerRadius) {
      styles.push(`border-radius: ${this.round(node.cornerRadius)}px`);
    }
    
    return styles.join('; ');
  }

  translateEllipseStyle(node, parentHasAutoLayout = false) {
    const styles = [];
    const bbox = node.absoluteBoundingBox;
    
    if (bbox) {
      styles.push(`width: ${this.round(bbox.width)}px`);
      styles.push(`height: ${this.round(bbox.height)}px`);
    }
    
    styles.push('border-radius: 50%');
    
    if (node.fills && node.fills.length > 0) {
      const fill = node.fills.find(f => f.visible !== false);
      if (fill) {
        const fillCSS = this.translateFillToCSS(fill);
        if (fillCSS) {
          if (fillCSS.includes('gradient')) {
            styles.push(`background: ${fillCSS}`);
          } else {
            styles.push(`background-color: ${fillCSS}`);
          }
        }
      }
    }
    
    if (node.strokes && node.strokes.length > 0) {
      const stroke = node.strokes.find(s => s.visible !== false);
      if (stroke) {
        const strokeColor = this.translateFillToCSS(stroke);
        const strokeWeight = node.strokeWeight || 1;
        if (strokeColor && !strokeColor.includes('gradient')) {
          styles.push(`border: ${this.round(strokeWeight)}px solid ${strokeColor}`);
        }
      }
    }
    
    return styles.join('; ');
  }

  getSemanticTag(node) {
    const name = (node.name || '').toLowerCase();
    if (name.includes('button') || name.includes('btn')) return 'button';
    if (name.includes('link')) return 'a';
    if (name.includes('input') || name.includes('field')) return 'input';
    if (name.includes('image') || name.includes('img') || name.includes('photo')) return 'img';
    if (name.includes('heading') || name.includes('title')) {
      if (name.includes('h1') || name.includes('main')) return 'h1';
      if (name.includes('h2') || name.includes('section')) return 'h2';
      if (name.includes('h3') || name.includes('sub')) return 'h3';
      return 'h2';
    }
    if (name.includes('nav')) return 'nav';
    if (name.includes('header')) return 'header';
    if (name.includes('footer')) return 'footer';
    if (name.includes('section')) return 'section';
    if (name.includes('article')) return 'article';
    if (name.includes('list')) return 'ul';
    if (name.includes('item')) return 'li';
    return 'p';
  }

  translateNodeToHTML(node, depth = 0, parentHasAutoLayout = false) {
    if (!node) return '';
    if (node.visible === false) return '';
    
    const indent = '  '.repeat(depth);
    const className = this.getClassName(node.name);
    const nodeHasAutoLayout = !!node.layoutMode;
    let html = '';
    
    switch (node.type) {
      case 'FRAME':
      case 'GROUP':
        // Check for Lottie animation
        if (this.hasLottieFill(node)) {
          const lottieUrl = this.getLottieUrl(node);
          const lottieStyle = this.translateVideoStyle(node, parentHasAutoLayout);
          console.log(`  🎭 Rendering Lottie: ${lottieUrl}`);
          
          if (this.isDirectLottieUrl(lottieUrl)) {
            html = `${indent}<dotlottie-wc class="${className}" data-figma-id="${node.id}" src="${lottieUrl}" speed="1" style="${lottieStyle}" loop autoplay></dotlottie-wc>`;
          } else {
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
        // Check for Lottie, GIF, video, or image
        if (this.hasLottieFill(node)) {
          const lottieUrl = this.getLottieUrl(node);
          const lottieStyle = this.translateVideoStyle(node, parentHasAutoLayout);
          
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
        } else if (this.hasGifFill(node)) {
          const gifUrl = this.getGifUrl(node.id);
          const gifStyle = this.translateVideoStyle(node, parentHasAutoLayout);
          html = `${indent}<img class="${className}" data-figma-id="${node.id}" src="${gifUrl}" alt="${node.name}" style="${gifStyle}" />`;
        } else {
          const videoUrl = this.getVideoUrl(node.id);
          if (videoUrl) {
            const videoStyle = this.translateVideoStyle(node, parentHasAutoLayout);
            html = `${indent}<div class="${className} video-container" data-figma-id="${node.id}" data-video-name="${node.name}" style="${videoStyle}; background-image: url('${videoUrl}'); background-size: cover; background-position: center; position: relative;">
${indent}  <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 48px; height: 48px; background: rgba(0,0,0,0.6); border-radius: 50%; display: flex; align-items: center; justify-content: center;">
${indent}    <svg width="24" height="24" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
${indent}  </div>
${indent}</div>`;
          } else {
            const imageUrl = this.getImageUrl(node.id);
            if (imageUrl) {
              const imgStyle = this.translateAutoLayoutToCSS(node);
              html = `${indent}<img class="${className}" data-figma-id="${node.id}" src="${imageUrl}" alt="${node.name}" style="${imgStyle}" />`;
            } else {
              const rectStyle = this.translateAutoLayoutToCSS(node);
              html = `${indent}<div class="${className}" data-figma-id="${node.id}" style="${rectStyle}"></div>`;
            }
          }
        }
        break;
        
      case 'ELLIPSE':
        const ellipseStyle = this.translateEllipseStyle(node, parentHasAutoLayout);
        html = `${indent}<div class="${className}" data-figma-id="${node.id}" style="${ellipseStyle}"></div>`;
        break;
        
      case 'VECTOR':
      case 'BOOLEAN_OPERATION':
      case 'LINE':
      case 'REGULAR_POLYGON':
      case 'STAR':
        const svgContent = this.getSvgContent(node.id);
        if (svgContent) {
          const bbox = node.absoluteBoundingBox;
          const width = bbox ? this.round(bbox.width) : 24;
          const height = bbox ? this.round(bbox.height) : 24;
          const cleanSvg = svgContent
            .replace(/<\?xml[^>]*\?>/g, '')
            .replace(/<!DOCTYPE[^>]*>/g, '')
            .replace(/width="[^"]*"/, `width="${width}"`)
            .replace(/height="[^"]*"/, `height="${height}"`)
            .trim();
          html = `${indent}<div class="${className}" data-figma-id="${node.id}" style="width: ${width}px; height: ${height}px; display: inline-block;">
${indent}  ${cleanSvg}
${indent}</div>`;
        } else {
          const vectorStyle = this.translateAutoLayoutToCSS(node);
          html = `${indent}<div class="${className}" data-figma-id="${node.id}" style="${vectorStyle}"></div>`;
        }
        break;
        
      case 'TEXT':
        const textStyle = this.translateTextStyle(node, parentHasAutoLayout);
        const textContent = node.characters || '';
        const tag = this.getSemanticTag(node);
        html = `${indent}<${tag} class="${className}" data-figma-id="${node.id}" style="${textStyle}">${textContent}</${tag}>`;
        break;
        
      case 'INSTANCE':
      case 'COMPONENT':
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

  compile(figmaData) {
    let nodeToRender = figmaData;
    
    if (figmaData.nodes) {
      const firstNodeKey = Object.keys(figmaData.nodes)[0];
      if (firstNodeKey) {
        nodeToRender = figmaData.nodes[firstNodeKey].document;
      }
    }
    
    return this.translateNodeToHTML(nodeToRender);
  }

  getCodeConnectMap() {
    return this.codeConnectMap;
  }
}

module.exports = CompilerEngine;
