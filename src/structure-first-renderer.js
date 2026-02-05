/**
 * Structure-First Layout Renderer
 * Preserves Figma Auto Layout as structural containers
 * Maps semantic UI elements to RK Design System components
 */

const React = require('react');

// RK Design System component mapping
const RK_COMPONENTS = {
  'HEADING': 'Heading',
  'BODY': 'Body',
  'BUTTON': 'Button',
  'CARD': 'Card',
  'LINK': 'Link',
  'ALERT': 'Alert',
  'TAG': 'Tag',
  'BADGE': 'Badge',
  'TEXTFIELD': 'Textfield',
  'SELECT': 'Select',
  'CHECKBOX': 'Checkbox',
  'RADIO': 'Radio',
  'SWITCH': 'Switch'
};

// Token mapping for Figma → RK
const TOKEN_MAPPING = {
  // Size tokens (Figma spacing → RK size tokens)
  sizes: {
    0: '--ds-size-0',
    4: '--ds-size-1',
    8: '--ds-size-2',
    12: '--ds-size-3',
    16: '--ds-size-4',
    24: '--ds-size-6',
    32: '--ds-size-8',
    48: '--ds-size-12',
    60: '--ds-size-15',
    120: '--ds-size-30'
  },
  
  // Color tokens
  colors: {
    '#D52B1E': '--ds-color-primary-color-red-base-default',
    '#b42419': '--ds-color-primary-color-red-text-subtle',
    '#57110c': '--ds-color-primary-color-red-text-default',
    '#2b2b2b': '--ds-color-neutral-text-default',
    '#ffffff': '--ds-color-neutral-background-default'
  },
  
  // Font sizes
  fontSizes: {
    16: '--ds-font-size-3',
    18: '--ds-font-size-4',
    21: '--ds-font-size-5',
    24: '--ds-font-size-6',
    30: '--ds-font-size-7',
    36: '--ds-font-size-8',
    48: '--ds-font-size-9',
    60: '--ds-font-size-10'
  }
};

class StructureFirstRenderer {
  constructor() {
    this.componentCache = new Map();
  }

  /**
   * Main render function - structure-first approach
   */
  renderNode(node, depth = 0) {
    if (!node) return null;

    // Priority 1: Auto Layout frames = structural containers
    if (this.isAutoLayoutFrame(node)) {
      return this.renderAutoLayoutFrame(node, depth);
    }

    // Priority 2: Semantic UI elements = RK components
    if (this.isSemanticUIElement(node)) {
      return this.renderSemanticComponent(node, depth);
    }

    // Priority 3: Everything else = structural container
    return this.renderStructuralContainer(node, depth);
  }

  /**
   * Check if node is an Auto Layout frame
   */
  isAutoLayoutFrame(node) {
    return node.layoutMode && node.layoutMode !== 'NONE';
  }

  /**
   * Check if node should be mapped to RK component
   */
  isSemanticUIElement(node) {
    const name = node.name?.toLowerCase() || '';
    const semanticPatterns = [
      /^heading/i,
      /^body/i,
      /^button/i,
      /^card/i,
      /^link/i,
      /^alert/i,
      /^tag/i,
      /^badge/i,
      /^textfield/i,
      /^input/i,
      /^select/i,
      /^checkbox/i,
      /^radio/i,
      /^switch/i
    ];
    
    return semanticPatterns.some(pattern => pattern.test(name));
  }

  /**
   * Render Auto Layout frame as structural container
   */
  renderAutoLayoutFrame(node, depth) {
    const layoutProps = this.extractLayoutProps(node);
    const children = node.children?.map(child => this.renderNode(child, depth + 1));
    
    // Create structural container (not RK component)
    return {
      type: 'div',
      props: {
        'data-figma-id': node.id,
        'data-figma-name': node.name,
        'data-figma-type': 'autolayout',
        style: layoutProps
      },
      children: children
    };
  }

  /**
   * Render semantic UI element as RK component
   */
  renderSemanticComponent(node, depth) {
    const componentType = this.detectComponentType(node);
    const rkProps = this.extractRKProps(node);
    const children = this.extractComponentChildren(node);
    
    // Get RK component name
    const rkComponentName = RK_COMPONENTS[componentType];
    
    if (!rkComponentName) {
      console.warn(`Unknown component type: ${componentType}`);
      return this.renderStructuralContainer(node, depth);
    }

    // Return RK component configuration
    return {
      type: 'rk-component',
      component: rkComponentName,
      props: {
        'data-figma-id': node.id,
        'data-figma-name': node.name,
        ...rkProps
      },
      children: children
    };
  }

  /**
   * Render structural container (fallback)
   */
  renderStructuralContainer(node, depth) {
    const children = node.children?.map(child => this.renderNode(child, depth + 1));
    
    return {
      type: 'div',
      props: {
        'data-figma-id': node.id,
        'data-figma-name': node.name,
        'data-figma-type': 'container',
        style: this.extractBasicStyles(node)
      },
      children: children
    };
  }

  /**
   * Extract layout properties from Auto Layout frame
   */
  extractLayoutProps(node) {
    const props = {
      display: 'flex',
      flexDirection: node.layoutMode === 'VERTICAL' ? 'column' : 'row',
      width: node.absoluteBoundingBox?.width ? `${node.absoluteBoundingBox.width}px` : 'auto',
      height: node.absoluteBoundingBox?.height ? `${node.absoluteBoundingBox.height}px` : 'auto'
    };

    // Gap (item spacing)
    if (node.itemSpacing !== undefined && node.itemSpacing > 0) {
      props.gap = this.mapSizeToToken(node.itemSpacing);
    }

    // Padding
    const paddingTop = node.paddingTop || 0;
    const paddingRight = node.paddingRight || 0;
    const paddingBottom = node.paddingBottom || 0;
    const paddingLeft = node.paddingLeft || 0;
    
    if (paddingTop || paddingRight || paddingBottom || paddingLeft) {
      props.padding = `${this.mapSizeToToken(paddingTop)} ${this.mapSizeToToken(paddingRight)} ${this.mapSizeToToken(paddingBottom)} ${this.mapSizeToToken(paddingLeft)}`;
    }

    // Alignment
    if (node.primaryAxisAlignItems) {
      props.justifyContent = this.mapAlignment(node.primaryAxisAlignItems);
    }
    
    if (node.counterAxisAlignItems) {
      props.alignItems = this.mapAlignment(node.counterAxisAlignItems);
    }

    // Background color
    if (node.fills?.[0]?.color) {
      props.backgroundColor = this.mapColorToToken(node.fills[0].color);
    }

    return props;
  }

  /**
   * Detect component type from node name
   */
  detectComponentType(node) {
    const name = node.name?.toLowerCase() || '';
    
    if (name.includes('heading')) return 'HEADING';
    if (name.includes('body') || name.includes('text')) return 'BODY';
    if (name.includes('button')) return 'BUTTON';
    if (name.includes('card')) return 'CARD';
    if (name.includes('link')) return 'LINK';
    if (name.includes('alert')) return 'ALERT';
    if (name.includes('tag')) return 'TAG';
    if (name.includes('badge')) return 'BADGE';
    if (name.includes('textfield') || name.includes('input')) return 'TEXTFIELD';
    if (name.includes('select') || name.includes('dropdown')) return 'SELECT';
    if (name.includes('checkbox')) return 'CHECKBOX';
    if (name.includes('radio')) return 'RADIO';
    if (name.includes('switch')) return 'SWITCH';
    
    return null;
  }

  /**
   * Extract RK component props from Figma node
   */
  extractRKProps(node) {
    const props = {};
    const name = node.name?.toLowerCase() || '';

    // Detect component type for specific props
    if (name.includes('heading')) {
      // Heading level
      if (name.includes('xxlarge') || name.includes('2xl')) {
        props.level = 1;
        props['data-size'] = 'xl';
      } else if (name.includes('xlarge') || name.includes('xl')) {
        props.level = 2;
        props['data-size'] = 'lg';
      } else if (name.includes('large') || name.includes('lg')) {
        props.level = 3;
        props['data-size'] = 'md';
      } else if (name.includes('medium') || name.includes('md')) {
        props.level = 4;
        props['data-size'] = 'sm';
      } else if (name.includes('small') || name.includes('sm')) {
        props.level = 5;
        props['data-size'] = 'xs';
      }
    }

    // Font size mapping
    if (node.style?.fontSize) {
      props['data-size'] = this.mapFontSizeToSize(node.style.fontSize);
    }

    // Color mapping
    if (node.fills?.[0]?.color) {
      props['data-color'] = this.mapColorToRKColor(node.fills[0].color);
    }

    // Button variant
    if (name.includes('button')) {
      if (name.includes('primary')) props.variant = 'primary';
      else if (name.includes('secondary')) props.variant = 'secondary';
      else if (name.includes('tertiary')) props.variant = 'tertiary';
    }

    return props;
  }

  /**
   * Extract children content for component
   */
  extractComponentChildren(node) {
    if (node.characters) {
      return node.characters;
    }
    
    if (node.children) {
      return node.children.map(child => this.renderNode(child));
    }
    
    return null;
  }

  /**
   * Map Figma size to RK size token
   */
  mapSizeToToken(figmaSize) {
    const sizeMap = {
      0: '0px',
      4: 'var(--ds-size-1)',
      8: 'var(--ds-size-2)',
      12: 'var(--ds-size-3)',
      16: 'var(--ds-size-4)',
      24: 'var(--ds-size-6)',
      32: 'var(--ds-size-8)',
      48: 'var(--ds-size-12)',
      60: 'var(--ds-size-15)',
      120: 'var(--ds-size-30)'
    };
    
    return sizeMap[figmaSize] || `${figmaSize}px`;
  }

  /**
   * Map Figma alignment to CSS flexbox
   */
  mapAlignment(figmaAlignment) {
    const alignmentMap = {
      'MIN': 'flex-start',
      'CENTER': 'center',
      'MAX': 'flex-end',
      'SPACE_BETWEEN': 'space-between'
    };
    
    return alignmentMap[figmaAlignment] || 'flex-start';
  }

  /**
   * Map Figma font size to RK size
   */
  mapFontSizeToSize(fontSize) {
    const sizeMap = {
      16: 'sm',
      18: 'md',
      21: 'md',
      24: 'lg',
      30: 'xl',
      36: '2xl',
      48: '2xl',
      60: '2xl'
    };
    
    return sizeMap[fontSize] || 'md';
  }

  /**
   * Map Figma color to RK color token
   */
  mapColorToRKColor(figmaColor) {
    if (!figmaColor) return 'neutral';
    
    // Convert RGB to hex if needed
    let hex = figmaColor;
    if (typeof figmaColor === 'object') {
      const r = Math.round(figmaColor.r * 255).toString(16).padStart(2, '0');
      const g = Math.round(figmaColor.g * 255).toString(16).padStart(2, '0');
      const b = Math.round(figmaColor.b * 255).toString(16).padStart(2, '0');
      hex = `#${r}${g}${b}`;
    }
    
    // Map to RK color names
    if (hex.includes('D52B1E') || hex.includes('b42419')) return 'accent';
    if (hex.includes('2b2b2b')) return 'neutral';
    if (hex.includes('ffffff')) return 'neutral';
    
    return 'neutral';
  }

  /**
   * Extract basic styles for structural containers
   */
  extractBasicStyles(node) {
    const styles = {};
    
    if (node.absoluteBoundingBox) {
      styles.width = `${node.absoluteBoundingBox.width}px`;
      styles.height = `${node.absoluteBoundingBox.height}px`;
    }
    
    if (node.fills?.[0]?.color) {
      styles.backgroundColor = this.mapColorToToken(node.fills[0].color);
    }
    
    return styles;
  }

  /**
   * Map color to CSS token
   */
  mapColorToToken(figmaColor) {
    if (!figmaColor) return 'transparent';
    
    // Convert RGB to hex if needed
    let hex = figmaColor;
    if (typeof figmaColor === 'object') {
      const r = Math.round(figmaColor.r * 255).toString(16).padStart(2, '0');
      const g = Math.round(figmaColor.g * 255).toString(16).padStart(2, '0');
      const b = Math.round(figmaColor.b * 255).toString(16).padStart(2, '0');
      hex = `#${r}${g}${b}`;
    }
    
    const tokenMap = {
      '#D52B1E': 'var(--ds-color-primary-color-red-base-default)',
      '#b42419': 'var(--ds-color-primary-color-red-text-subtle)',
      '#57110c': 'var(--ds-color-primary-color-red-text-default)',
      '#2b2b2b': 'var(--ds-color-neutral-text-default)',
      '#ffffff': 'var(--ds-color-neutral-background-default)'
    };
    
    return tokenMap[hex] || hex;
  }
}

module.exports = { StructureFirstRenderer };
