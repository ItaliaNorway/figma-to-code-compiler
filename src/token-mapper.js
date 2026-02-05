/**
 * Token Mapper Utility
 * Maps Figma values to RK Design System tokens
 */

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
  
  // Font sizes (Figma font size → RK font size tokens)
  fontSizes: {
    12: '--ds-font-size-1',
    14: '--ds-font-size-2',
    16: '--ds-font-size-3',
    18: '--ds-font-size-4',
    21: '--ds-font-size-5',
    24: '--ds-font-size-6',
    30: '--ds-font-size-7',
    36: '--ds-font-size-8',
    48: '--ds-font-size-9',
    60: '--ds-font-size-10'
  },
  
  // RK component names
  components: {
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
  }
};

/**
 * Map Figma size to RK size token
 */
function mapSizeToToken(figmaSize) {
  if (figmaSize === 0 || figmaSize === undefined) return '0px';
  
  // Find closest size
  const sizes = Object.keys(TOKEN_MAPPING.sizes).map(Number).sort((a, b) => a - b);
  const closest = sizes.find(s => s >= figmaSize) || sizes[sizes.length - 1];
  
  return `var(${TOKEN_MAPPING.sizes[closest]})`;
}

/**
 * Map Figma font size to RK size prop
 */
function mapFontSizeToSize(figmaFontSize) {
  const sizeMap = {
    12: 'sm',
    14: 'sm',
    16: 'md',
    18: 'md',
    21: 'md',
    24: 'lg',
    30: 'xl',
    36: '2xl',
    48: '2xl',
    60: '2xl'
  };
  
  return sizeMap[figmaFontSize] || 'md';
}

/**
 * Map Figma color to RK color name
 */
function mapColorToRKColor(figmaColor) {
  if (!figmaColor) return 'neutral';
  
  // Handle RGB object
  let hex;
  if (typeof figmaColor === 'object') {
    const r = Math.round((figmaColor.r || 1) * 255).toString(16).padStart(2, '0');
    const g = Math.round((figmaColor.g || 1) * 255).toString(16).padStart(2, '0');
    const b = Math.round((figmaColor.b || 1) * 255).toString(16).padStart(2, '0');
    hex = `#${r}${g}${b}`.toLowerCase();
  } else {
    hex = figmaColor.toLowerCase();
  }
  
  // Map to RK color names
  if (hex.includes('d52b1e') || hex.includes('b42419')) return 'accent';
  if (hex.includes('57110c')) return 'danger';
  if (hex.includes('2b2b2b')) return 'neutral';
  if (hex.includes('ffffff') || hex.includes('fff')) return 'neutral';
  
  return 'neutral';
}

/**
 * Map Figma alignment to CSS
 */
function mapAlignment(figmaAlignment) {
  const alignmentMap = {
    'MIN': 'flex-start',
    'CENTER': 'center',
    'MAX': 'flex-end',
    'SPACE_BETWEEN': 'space-between',
    'STRETCH': 'stretch'
  };
  
  return alignmentMap[figmaAlignment] || 'flex-start';
}

/**
 * Detect component type from Figma node name
 */
function detectComponentType(nodeName) {
  if (!nodeName) return null;
  
  const name = nodeName.toLowerCase();
  
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
 * Check if node is semantic UI element
 */
function isSemanticUIElement(nodeName) {
  return detectComponentType(nodeName) !== null;
}

/**
 * Get heading level from node name
 */
function getHeadingLevel(nodeName) {
  const name = nodeName?.toLowerCase() || '';
  
  if (name.includes('xxlarge') || name.includes('2xl')) return 1;
  if (name.includes('xlarge') || name.includes('xl')) return 2;
  if (name.includes('large') || name.includes('lg')) return 3;
  if (name.includes('medium') || name.includes('md')) return 4;
  if (name.includes('small') || name.includes('sm')) return 5;
  if (name.includes('xs') || name.includes('2xs')) return 6;
  
  return 2; // Default to h2
}

module.exports = {
  TOKEN_MAPPING,
  mapSizeToToken,
  mapFontSizeToSize,
  mapColorToRKColor,
  mapAlignment,
  detectComponentType,
  isSemanticUIElement,
  getHeadingLevel
};
