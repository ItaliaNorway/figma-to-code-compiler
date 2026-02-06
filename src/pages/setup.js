/**
 * Setup Page Generator
 * Generates the HTML for the setup/configuration page
 */

function generateSetupPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Figma MCP Compiler - Setup</title>
    <link href="https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; }
        
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
        
        .step-icon { font-size: 32px; margin-bottom: 10px; }
        .step-title { font-weight: 600; font-size: 14px; color: #1e1e1e; margin-bottom: 5px; }
        .step-desc { font-size: 12px; color: #666; }
        
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
        
        .form-group { margin-bottom: 20px; }
        .form-group label { display: block; font-size: 14px; font-weight: 500; color: #1e1e1e; margin-bottom: 8px; }
        .form-group .hint { font-size: 12px; color: #888; margin-top: 6px; }
        .form-group .hint a { color: #C01B1B; }
        
        .input-group { display: flex; gap: 10px; }
        .input-group input { flex: 1; }
        
        input[type="text"], input[type="password"], input[type="url"] {
            width: 100%;
            padding: 12px 14px;
            border: 1px solid #ddd;
            border-radius: 6px;
            font-size: 14px;
            font-family: inherit;
        }
        
        input:focus { outline: none; border-color: #C01B1B; }
        
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
        
        .btn-primary { background: #C01B1B; color: white; }
        .btn-primary:hover { background: #a01717; }
        .btn-secondary { background: #1e1e1e; color: white; }
        .btn-secondary:hover { background: #333; }
        .btn-outline { background: white; color: #1e1e1e; border: 1px solid #ddd; }
        .btn-outline:hover { background: #f5f5f5; }
        
        .status-indicator {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-size: 13px;
            padding: 6px 12px;
            border-radius: 4px;
            margin-top: 10px;
        }
        
        .status-success { background: #E8F5E9; color: #2E7D32; }
        .status-error { background: #FFEBEE; color: #C62828; }
        .status-pending { background: #FFF3E0; color: #E65100; }
        
        .radio-group { display: flex; flex-direction: column; gap: 12px; }
        
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
        
        .radio-option:hover { border-color: #ddd; }
        .radio-option.selected { border-color: #C01B1B; background: #FEF2F2; }
        .radio-option input[type="radio"] { margin-top: 3px; accent-color: #C01B1B; }
        .radio-content { flex: 1; }
        .radio-title { font-weight: 600; font-size: 15px; color: #1e1e1e; margin-bottom: 4px; }
        .radio-desc { font-size: 13px; color: #666; }
        
        .design-system-options {
            margin-top: 15px;
            padding: 15px;
            background: #f9f9f9;
            border-radius: 6px;
            display: none;
        }
        
        .design-system-options.visible { display: block; }
        
        .checkbox-group { display: flex; align-items: center; gap: 8px; margin-top: 15px; }
        .checkbox-group input[type="checkbox"] { accent-color: #C01B1B; width: 18px; height: 18px; }
        .checkbox-group label { font-size: 14px; color: #1e1e1e; margin: 0; }
        
        .continue-section { text-align: center; padding-top: 10px; }
        .continue-section .btn { min-width: 200px; }
        .arrow-icon { margin-left: 8px; }
        #tokenStatus { display: none; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎨 Figma MCP Compiler</h1>
            <p>Convert Figma designs to pixel-perfect HTML/CSS/React</p>
        </div>
        
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
                <div class="no-ai-badge">✓ No AI code generation — deterministic rule-based translation</div>
            </div>
        </div>
        
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
                    <label>Design Tokens CSS URL</label>
                    <input type="url" id="tokensUrl" placeholder="https://example.com/design-tokens/theme.css">
                    <div class="hint">URL to your design system's CSS variables file</div>
                </div>
                <div class="form-group">
                    <label>Component CSS URL (optional)</label>
                    <input type="url" id="cssUrl" placeholder="https://example.com/designsystem/index.css">
                    <div class="hint">Additional CSS for component styles</div>
                </div>
                <div class="checkbox-group">
                    <input type="checkbox" id="codeConnectEnabled">
                    <label for="codeConnectEnabled">Enable Code Connect (map Figma components to React)</label>
                </div>
            </div>
        </div>
        
        <div class="continue-section">
            <button class="btn btn-primary" onclick="saveAndContinue()">
                Save & Continue to Compiler <span class="arrow-icon">→</span>
            </button>
        </div>
    </div>
    
    <script>
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
                if (config.designSystem.tokensUrl) {
                    document.getElementById('tokensUrl').value = config.designSystem.tokensUrl;
                }
                if (config.designSystem.cssUrl) {
                    document.getElementById('cssUrl').value = config.designSystem.cssUrl;
                }
                if (config.designSystem.codeConnectEnabled) {
                    document.getElementById('codeConnectEnabled').checked = true;
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
        
        function saveAndContinue() {
            const token = document.getElementById('figmaToken').value.trim();
            
            if (!token) {
                alert('Please enter your Figma access token');
                return;
            }
            
            const mode = document.querySelector('input[name="mode"]:checked').value;
            
            const config = {
                figmaToken: token,
                tokenValidated: true,
                mode: mode,
                designSystem: {
                    tokensUrl: document.getElementById('tokensUrl').value.trim(),
                    cssUrl: document.getElementById('cssUrl').value.trim(),
                    codeConnectEnabled: document.getElementById('codeConnectEnabled').checked
                }
            };
            
            localStorage.setItem('figmaCompilerConfig', JSON.stringify(config));
            window.location.href = '/compiler';
        }
    </script>
</body>
</html>`;
}

module.exports = { generateSetupPage };
