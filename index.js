import 'dotenv/config';
import express from "express";
import { execFile } from "child_process";
import { v4 as uuid } from "uuid";
import fs from "fs/promises";
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();
app.use(express.json({ limit: "4mb" }));

// Initialize Gemini AI
let genAI;
const initializeGemini = () => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
        genAI = new GoogleGenerativeAI(apiKey);
        console.log("✅ Gemini AI initialized successfully");
    } else {
        console.log("⚠️  Gemini API key not found - AI suggestions will be disabled");
    }
};

// Initialize Gemini on startup
initializeGemini();

// Health check endpoint with PMD test
app.get("/health", async (req, res) => {
    let pmdStatus = 'unknown';
    try {
        // Test if PMD scanner is available
        const pmdTest = await exec("sf", ["scanner", "--help"]);
        pmdStatus = 'available';
    } catch (error) {
        pmdStatus = 'not available: ' + error.message;
    }

    res.json({ 
        status: "ok", 
        message: "PMD-Gemini Service is running",
        geminiAvailable: !!genAI,
        pmdStatus: pmdStatus,
        timestamp: new Date().toISOString()
    });
});

// CORS headers for Salesforce
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

// POST /run - PMD Scanning endpoint
app.post("/run", async (req, res) => {
    // Set a longer timeout for this endpoint
    req.setTimeout(55000); // 55 seconds to stay under Salesforce 60s limit
    res.setTimeout(55000);
    
    try {
        console.log("🔍 Received PMD scan request");
        const { filename, source } = req.body;
        
        if (!filename || !source) {
            return res.status(400).json({ 
                error: "Both 'filename' and 'source' fields are required" 
            });
        }

        // Check file size to prevent very large files from timing out
        if (source.length > 100000) { // 100KB limit
            console.log(`⚠️  Large file detected: ${source.length} characters`);
            return res.status(400).json({
                error: "File too large for analysis. PMD analysis is limited to files under 100KB. Please try a smaller class."
            });
        }

        const tmp = `/tmp/${uuid()}-${filename}`;
        await fs.writeFile(tmp, source, "utf8");
        
        console.log(`📁 Created temporary file: ${tmp} (${source.length} chars)`);
        console.log(`🔍 Running PMD analysis on ${filename}...`);
        
        // Debug: Check if file was created properly
        try {
            const fileStats = await fs.stat(tmp);
            console.log(`📊 File created successfully: ${fileStats.size} bytes`);
        } catch (statError) {
            console.log(`❌ File creation failed: ${statError.message}`);
        }

        // Use legacy PMD scanner which works better for rule detection
        console.log(`🚀 Executing: sf scanner run --engine pmd --format json --target ${tmp}`);
        
        const pmdOutput = await Promise.race([
            exec("sf", [
                "scanner",
                "run",
                "--engine", "pmd",
                "--format", "json",
                "--target", tmp,
            ]),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('PMD analysis timed out after 45 seconds')), 45000)
            )
        ]);
        
        console.log(`📤 PMD raw output length: ${pmdOutput.length} characters`);
        console.log(`📤 PMD raw output: ${pmdOutput}`);
        
        // Clean up temporary file
        await fs.unlink(tmp);
        console.log("🧹 Cleaned up temporary file");
        
        // Parse PMD results (legacy format is more reliable)
        let result;
        try {
            if (pmdOutput.trim()) {
                result = JSON.parse(pmdOutput);
                console.log(`📊 Parsed ${result.length} PMD violations`);
            } else {
                console.log(`⚠️ PMD returned empty output`);
                result = [];
            }
        } catch (parseError) {
            console.log("❌ Failed to parse PMD output as JSON:", parseError.message);
            console.log("📄 Raw PMD output:", pmdOutput);
            result = [];
        }
        
        console.log(`✅ PMD scan completed - found ${result.length} issues`);
        res.json(result);
        
    } catch (error) {
        console.error("❌ Code Analyzer scan error:", error);
        
        // Provide helpful error messages based on error type
        let errorMessage = "PMD scan failed";
        if (error.message.includes('timed out')) {
            errorMessage = "Analysis timed out. The file may be too large or complex for PMD analysis.";
        } else if (error.message.includes('ENOENT')) {
            errorMessage = "PMD tool not found. Please contact administrator.";
        } else if (error.message.includes('command not found')) {
            errorMessage = "Code Analyzer not properly installed.";
        } else {
            errorMessage = `PMD scan failed: ${error.message}`;
        }
        
        res.status(500).json({ 
            error: errorMessage,
            details: error.toString()
        });
    }
});

// POST /fix - AI Fix Suggestions endpoint
app.post("/fix", async (req, res) => {
    try {
        console.log("🤖 Received AI fix suggestion request");
        const { prompt, code } = req.body;
        
        if (!prompt || !code) {
            return res.status(400).json({ 
                error: "Both 'prompt' and 'code' fields are required" 
            });
        }

        if (!genAI) {
            return res.status(503).json({ 
                error: "Gemini AI service not available - check GEMINI_API_KEY environment variable" 
            });
        }

        // Get Gemini model (use the correct model name)
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        // Create detailed prompt for Apex code fixing
        const fullPrompt = `You are an expert Salesforce Apex developer. 

TASK: Fix the following Apex code to resolve this PMD violation: "${prompt}"

CODE TO FIX:
\`\`\`apex
${code}
\`\`\`

REQUIREMENTS:
1. Provide the corrected code snippet
2. Explain what was wrong and why the fix works
3. Keep the solution concise and focused
4. Maintain the original functionality
5. Follow Salesforce best practices

FORMAT YOUR RESPONSE AS:
**Fixed Code:**
\`\`\`apex
[corrected code here]
\`\`\`

**Explanation:**
[Brief explanation of the fix]

**Why This Fix Works:**
[Why this resolves the PMD violation]`;

        console.log("🤖 Calling Gemini AI...");
        
        // Generate response
        const result = await model.generateContent(fullPrompt);
        const response = await result.response;
        const suggestion = response.text();
        
        console.log("✅ AI suggestion generated successfully");
        res.json({ 
            patch: suggestion,
            model: "gemini-1.5-flash",
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error("❌ AI suggestion error:", error);
        
        // Provide helpful error messages
        let errorMessage = "Failed to generate AI suggestion";
        if (error.message.includes("API_KEY")) {
            errorMessage = "Invalid Gemini API key";
        } else if (error.message.includes("quota")) {
            errorMessage = "Gemini API quota exceeded";
        } else if (error.message.includes("safety")) {
            errorMessage = "Content blocked by safety filters";
        }
        
        res.status(500).json({ 
            error: errorMessage,
            details: error.message
        });
    }
});

// Utility function to parse Code Analyzer v5 table output
function parseCodeAnalyzerTableOutput(output) {
    const lines = output.split('\n');
    const violations = [];
    
    // Look for table rows (skip header and separator lines)
    for (const line of lines) {
        // Skip empty lines, headers, and separators
        if (!line.trim() || line.includes('─') || line.includes('Rule') || line.includes('Severity')) {
            continue;
        }
        
        // Try to parse table format: Rule | Severity | Line | Description | File
        const parts = line.split('│').map(part => part.trim()).filter(part => part);
        
        if (parts.length >= 4) {
            violations.push({
                ruleName: parts[0] || 'Unknown',
                severity: parts[1] || 'Info',
                line: parseInt(parts[2]) || 1,
                message: parts[3] || 'Code violation detected',
                fileName: parts[4] || 'Unknown'
            });
        }
    }
    
    return violations;
}

// Utility function to execute shell commands
function exec(bin, args) {
    return new Promise((resolve, reject) => {
        execFile(bin, args, { maxBuffer: 10_000_000 }, (error, stdout, stderr) => {
            if (error) {
                console.error("🚨 Command execution error:", stderr || error);
                reject(new Error(stderr || error.message));
            } else {
                resolve(stdout);
            }
        });
    });
}

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`🚀 PMD-Gemini Service running on port ${PORT}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/health`);
    console.log(`🤖 Gemini AI: ${genAI ? 'Ready' : 'Not configured'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('📴 SIGTERM received, shutting down gracefully');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('📴 SIGINT received, shutting down gracefully');
    process.exit(0);
});