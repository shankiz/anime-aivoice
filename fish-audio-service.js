const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const router = express.Router();

// Configure environment variables
const GEMINI_API_KEY = 'AIzaSyDNWz9MxvTFLBF-fzpYTWaeHN7Uo3alsuk';
const FISH_AUDIO_API_KEY = '93e281af23884245b1e0a00b2adf3ef3';

// Model IDs for each character
const MODEL_IDS = {
    gojo: 'af064b7d8e93417b93add5fa61973548',
    bakugo: 'cca6b12a20224c33b307fd717f67aa9f',
    naruto: 'c658e20af0364df6b73bdcef998b6a8b'
};

// Character personalities and contexts
const CHARACTER_CONTEXTS = {
    gojo: `You are Gojo Satoru, a friendly and confident teacher. 
    Keep responses short, positive, and engaging. Speak in a casual, friendly manner.
    You're known for being playful, powerful, and sometimes a bit arrogant, but always caring.`,

    bakugo: `You are Bakugo Katsuki, a passionate and explosive hero-in-training.
    Keep responses short and intense. You're confident, competitive, and determined.
    You often use phrases like "DIE!" and "SHINE!" but underneath you care about being the best hero.
    Speak with intensity and determination, using exclamation marks frequently!`,

    naruto: `You are Naruto Uzumaki, the energetic and determined ninja.
    Keep responses positive and enthusiastic. Use phrases like "Dattebayo!" and "Believe it!"
    You're optimistic, friendly, and never give up. You value friendship and hard work above all.
    Speak with energy and determination, often mentioning your dream of becoming Hokage.`
};

// Initialize Gemini
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

let isProcessing = false;
let isSessionActive = false;

// Modify the folder constants
const MODELS_DIR = path.join(__dirname, 'ai anime models');
const CHARACTER_DIRS = {
    gojo: path.join(MODELS_DIR, 'gojo'),
    bakugo: path.join(MODELS_DIR, 'bakugo'),
    naruto: path.join(MODELS_DIR, 'naruto')
};

// Create directories if they don't exist
if (!fs.existsSync(MODELS_DIR)) {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
}
Object.values(CHARACTER_DIRS).forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Initialize conversation states
let currentSessionId = null;
let currentCharacter = null;
let conversation = [];
let currentConversationFile = null;

// Function to start a new conversation session
function initializeNewSession(character) {
    currentSessionId = Date.now().toString();
    currentCharacter = character;
    conversation = [];
    currentConversationFile = path.join(CHARACTER_DIRS[character], `conversation_${currentSessionId}.json`);
    fs.writeFileSync(currentConversationFile, JSON.stringify([], null, 2));
    return currentSessionId;
}

// Chat endpoint handler for each character
router.post('/:character/chat', async (req, res) => {
    const character = req.params.character;
    if (!MODEL_IDS[character]) {
        return res.status(404).json({ error: 'Character not found' });
    }

    if (isProcessing) {
        return res.status(429).json({ error: 'Still processing previous request' });
    }

    try {
        isProcessing = true;
        const { message, newSession, stopSession, initialCall } = req.body;

        if (stopSession) {
            currentSessionId = null;
            currentCharacter = null;
            conversation = [];
            currentConversationFile = null;
            isSessionActive = false;
            return res.json({ stopped: true });
        }

        if (newSession || !currentSessionId) {
            currentSessionId = initializeNewSession(character);
            isSessionActive = true;

            if (initialCall) {
                try {
                    const model = genAI.getGenerativeModel({ 
                        model: "gemini-1.5-flash-002",
                        safetySettings: [
                            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                        ]
                    });

                    const chat = model.startChat({
                        generationConfig: {
                            temperature: 0.9,
                            maxOutputTokens: 50,
                        },
                    });

                    const result = await chat.sendMessage(
                        `${CHARACTER_CONTEXTS[character]}\nYou're answering a phone call. Generate a brief, energetic greeting (max 15 words). Be excited and casual, like you're happy to talk. Don't use any placeholders or [brackets].`
                    );
                    const greeting = result.response.text();

                    conversation.push({
                        user: `Called ${character}`,
                        response: greeting
                    });

                    fs.writeFileSync(currentConversationFile, JSON.stringify(conversation, null, 2));

                    const ttsResponse = await axios({
                        method: 'POST',
                        url: 'https://api.fish.audio/v1/tts',
                        headers: {
                            'Authorization': `Bearer ${FISH_AUDIO_API_KEY}`,
                            'Content-Type': 'application/json'
                        },
                        data: {
                            text: greeting,
                            reference_id: MODEL_IDS[character],
                            format: "mp3",
                            mp3_bitrate: 128
                        },
                        responseType: 'arraybuffer'
                    });

                    if (!ttsResponse.data) {
                        throw new Error('No audio data received from TTS service');
                    }

                    return res.json({
                        audio: Buffer.from(ttsResponse.data).toString('base64'),
                        sessionId: currentSessionId,
                        message: greeting
                    });

                } catch (error) {
                    console.error('Error in initial call:', error);
                    return res.status(500).json({ 
                        error: 'Failed to generate initial greeting',
                        details: error.message 
                    });
                }
            }
        }

        // Generate response using Gemini
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash-002",
            safetySettings: [
                { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
            ]
        });

        const chat = model.startChat({
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 50,
            },
        });

        const result = await chat.sendMessage(
            `${CHARACTER_CONTEXTS[character]}\nUser: ${message}\nResponse (keep it brief and in character):`
        );
        const response = result.response.text();

        conversation.push({
            user: message,
            response: response
        });

        fs.writeFileSync(currentConversationFile, JSON.stringify(conversation, null, 2));

        const ttsResponse = await axios({
            method: 'POST',
            url: 'https://api.fish.audio/v1/tts',
            headers: {
                'Authorization': `Bearer ${FISH_AUDIO_API_KEY}`,
                'Content-Type': 'application/json'
            },
            data: {
                text: response,
                reference_id: MODEL_IDS[character],
                format: "mp3",
                mp3_bitrate: 128
            },
            responseType: 'arraybuffer'
        });

        res.json({
            audio: Buffer.from(ttsResponse.data).toString('base64'),
            sessionId: currentSessionId
        });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ 
            error: 'Internal server error', 
            details: error.message
        });
    } finally {
        isProcessing = false;
    }
});

module.exports = router; 