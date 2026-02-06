/**
 * Compiler Page Generator
 * Generates the HTML for the compiler/preview page
 */

function generateCompilerPage({ renderedHTML, fileName, currentUrl, codeConnectMap }) {
  const displayHTML = renderedHTML || '<div style="text-align: center; padding: 60px; color: #888;"><p style="font-size: 48px; margin-bottom: 20px;">📋</p><p>Paste a Figma URL and click Load to preview your design</p></div>';
  const codeConnectJSON = JSON.stringify(codeConnectMap || {});
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Figma MCP Compiler</title>
    <link href="https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;500;600;700&display=swap" rel="stylesheet">
    <script src="https://unpkg.com/@lottiefiles/dotlottie-wc@latest/dist/dotlottie-wc.js" type="module"></script>
    <style>
        * { box-sizing: border-box; }
        
        body {
            font-family: 'Source Sans 3', sans-serif;
            margin: 0;
            padding: 20px;
            background: #f5f5f5;
        }
        
        .container { max-width: 1400px; margin: 0 auto; }
        
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
        
        .settings-btn, .refresh-btn {
            background: none;
            border: none;
            cursor: pointer;
            padding: 8px;
            border-radius: 4px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .settings-btn:hover, .refresh-btn:hover { background: #f5f5f5; }
        .settings-btn svg, .refresh-btn svg { width: 20px; height: 20px; color: #666; }
        
        .refresh-btn.loading svg { animation: spin 1s linear infinite; }
        
        @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
        
        .file-info { display: flex; align-items: center; gap: 10px; }
        .file-name { font-size: 14px; color: #666; }
        
        .link-input-group { display: flex; flex: 1; gap: 10px; }
        
        .url-input {
            flex: 1;
            padding: 10px 14px;
            border: 1px solid #E0E0E0;
            border-radius: 4px;
            font-size: 14px;
            font-family: inherit;
            color: #666;
        }
        
        .url-input:focus { outline: none; border-color: #1e1e1e; }
        
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
        
        .load-button:hover { background: #333; }
        .load-button:disabled { background: #ccc; cursor: not-allowed; }
        .load-button svg { width: 16px; height: 16px; }
        
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
        
        .toggle-btn:not(:last-child) { border-right: 1px solid #C01B1B; }
        .toggle-btn.active { background: #C01B1B; color: white; }
        .toggle-btn:hover:not(.active) { background: #FEF2F2; }
        
        .divider { height: 1px; background: #E0E0E0; width: 100%; }
        
        .figma-output {
            background: white !important;
            border: 1px solid #E0E0E0;
            border-radius: 4px;
            padding: 20px;
            overflow-x: auto;
        }
        
        /* Ensure preview area stays white regardless of injected CSS */
        #output-preview {
            background: white !important;
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
        
        .copy-btn:hover { background: #444; }
        
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
        
        h3 { margin: 0 0 10px 0; font-size: 16px; font-weight: 600; }
        h4 { margin: 15px 0 10px 0; font-size: 14px; font-weight: 600; }
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
                <input type="text" class="url-input" id="figmaUrl" placeholder="Figma design link" value="${currentUrl}">
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
                <button class="toggle-btn active" onclick="setOutputMode('preview')" id="btn-preview">Preview</button>
                <button class="toggle-btn" onclick="setOutputMode('html')" id="btn-html">HTML/CSS</button>
                <button class="toggle-btn" onclick="setOutputMode('react')" id="btn-react">React</button>
            </div>
        </div>
        
        <div class="divider"></div>
        
        <div id="errorMsg" class="error-message"></div>
        <div id="successMsg" class="success-message"></div>
        
        <div id="output-preview">
            <div class="figma-output">${displayHTML}</div>
        </div>
        
        <div id="output-html" style="display: none;">
            <button class="copy-btn" onclick="copyCode('html')">📋 Copy HTML</button>
            <pre class="code-output" id="html-code"></pre>
        </div>
        
        <div id="output-react" style="display: none;">
            <button class="copy-btn" onclick="copyCode('react')">📋 Copy React</button>
            <button class="copy-btn" onclick="copyCode('css')" style="margin-left: 5px;">📋 Copy CSS Module</button>
            <pre class="code-output" id="react-code"></pre>
            <h4>CSS Module (styles.module.css):</h4>
            <pre class="code-output" id="css-module-code"></pre>
        </div>
    </div>
    
    <script>
        const codeConnectMap = ${codeConnectJSON};
        
        function getConfig() {
            return JSON.parse(localStorage.getItem('figmaCompilerConfig') || '{}');
        }
        
        function goToSettings() {
            window.location.href = '/';
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
        
        function setOutputMode(mode) {
            document.querySelectorAll('.toggle-btn').forEach(btn => btn.classList.remove('active'));
            document.getElementById('btn-' + mode).classList.add('active');
            
            document.getElementById('output-preview').style.display = mode === 'preview' ? 'block' : 'none';
            document.getElementById('output-html').style.display = mode === 'html' ? 'block' : 'none';
            document.getElementById('output-react').style.display = mode === 'react' ? 'block' : 'none';
            
            if (mode === 'html') generateHTMLCode();
            else if (mode === 'react') generateReactCode();
        }
        
        function generateHTMLCode() {
            const preview = document.querySelector('.figma-output');
            if (preview) {
                const formatted = formatHTML(preview.innerHTML);
                document.getElementById('html-code').textContent = formatted;
            }
        }
        
        function generateReactCode() {
            const preview = document.querySelector('.figma-output');
            if (preview) {
                const { jsx, cssModule } = htmlToReact(preview.innerHTML);
                document.getElementById('react-code').textContent = jsx;
                document.getElementById('css-module-code').textContent = cssModule;
            }
        }
        
        function htmlToReact(html) {
            let jsx = html;
            const cssRules = [];
            const imports = new Set();
            let classCounter = 0;
            
            // Check for Code Connect components first
            const config = getConfig();
            if (config.designSystem?.codeConnectEnabled && Object.keys(codeConnectMap).length > 0) {
                for (const [nodeId, mapping] of Object.entries(codeConnectMap)) {
                    const pattern = 'data-figma-id="' + nodeId + '"';
                    if (jsx.includes(pattern)) {
                        imports.add("import { " + mapping.componentName + " } from '@redcross/design-system';");
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
                        jsx = jsx.substring(0, tagStart) + '<' + mapping.componentName + ' />' + jsx.substring(pos);
                    }
                }
            }
            
            jsx = jsx.replace(/\\bclass="/g, 'className="');
            
            jsx = jsx.replace(/style="([^"]*)"/g, (match, styleStr) => {
                const className = 'style' + (++classCounter);
                const cssProps = styleStr.split(';').filter(s => s.trim()).map(s => {
                    const [prop, val] = s.split(':').map(x => x.trim());
                    return '  ' + prop + ': ' + val + ';';
                }).join('\\n');
                cssRules.push('.' + className + ' {\\n' + cssProps + '\\n}');
                return 'className={styles.' + className + '}';
            });
            
            const cssModule = cssRules.join('\\n\\n');
            const importsStr = imports.size > 0 ? Array.from(imports).join('\\n') + '\\n\\n' : '';
            
            const reactCode = "import React from 'react';\\nimport styles from './styles.module.css';\\n" + importsStr + "\\nexport default function FigmaComponent() {\\n  return (\\n    <>\\n" + indent(jsx, 6) + "\\n    </>\\n  );\\n}";
            
            return { jsx: reactCode, cssModule };
        }
        
        function indent(str, spaces) {
            const pad = ' '.repeat(spaces);
            return str.split('\\n').map(line => pad + line).join('\\n');
        }
        
        function formatHTML(html) {
            let formatted = '';
            let indentLevel = 0;
            const lines = html.replace(/></g, '>\\n<').split('\\n');
            
            lines.forEach(line => {
                line = line.trim();
                if (!line) return;
                if (line.startsWith('</')) indentLevel = Math.max(0, indentLevel - 1);
                formatted += '  '.repeat(indentLevel) + line + '\\n';
                if (line.startsWith('<') && !line.startsWith('</') && !line.endsWith('/>') && !line.includes('</')) {
                    indentLevel++;
                }
            });
            
            return formatted.trim();
        }
        
        function copyCode(type) {
            let code = '';
            if (type === 'html') code = document.getElementById('html-code').textContent;
            else if (type === 'react') code = document.getElementById('react-code').textContent;
            else if (type === 'css') code = document.getElementById('css-module-code').textContent;
            
            navigator.clipboard.writeText(code).then(() => {
                const btn = event.target;
                const originalText = btn.textContent;
                btn.textContent = '✅ Copied!';
                setTimeout(() => btn.textContent = originalText, 1500);
            });
        }
        
        // Inject design system CSS on load
        document.addEventListener('DOMContentLoaded', () => {
            const config = getConfig();
            if (!config.figmaToken) {
                showError('No Figma token configured. Click the ⚙️ Settings button to set up.');
            }
            
            if (config.mode === 'designSystem' && config.designSystem) {
                if (config.designSystem.tokensUrl) {
                    const link = document.createElement('link');
                    link.rel = 'stylesheet';
                    link.href = config.designSystem.tokensUrl;
                    document.head.appendChild(link);
                }
                if (config.designSystem.cssUrl) {
                    const link = document.createElement('link');
                    link.rel = 'stylesheet';
                    link.href = config.designSystem.cssUrl;
                    document.head.appendChild(link);
                }
            }
        });
    </script>
</body>
</html>`;
}

module.exports = { generateCompilerPage };
