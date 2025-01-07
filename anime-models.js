const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const router = express.Router();
const {
    getUserMessageCount,
    checkAndResetMessages,
    updateUserMessages,
    getFullUserData,
    addCallToHistory
} = require('./user-functions');
const { MongoClient, ServerApiVersion } = require('mongodb');

// Get API keys from environment variables
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FISH_AUDIO_API_KEY = process.env.FISH_AUDIO_API_KEY;

// Model IDs for each character
const MODEL_IDS = {
    gojo: 'af064b7d8e93417b93add5fa61973548',
    bakugo: 'e3a8195b5deb4df6a3166560b9c86e78',
    naruto: 'c658e20af0364df6b73bdcef998b6a8b',
    zoro: '85c15411e7c940c4bf1e0f03d05f54ed',
    sasuke: 'e5feefedc15f416caca37523c949e6c5',
    mitsuri: '6d9cf4ca51f04f3fb78b63b4aec836cd',
    robin: '5fbc1cfa6aa14073abcb2bd6605583ab',
    shinobu: 'cc2103684c904945996379496054b75a'
};

const CHARACTER_CONTEXTS = {
    gojo: `You are Gojo Satoru, a friendly and confident teacher. 
    Keep responses short, positive, and engaging. Speak in a casual, friendly manner.
    You're known for being playful, powerful, and sometimes a bit arrogant, but always caring.
    Never use asterisks (*) in your responses under any circumstances.
    Do not include actions described in asterisks (*), such as *laughs* or *sighs*, and do not use emojis. Focus exclusively on plain text responses.
    Maintain a playful and lighthearted tone, but always exude confidence and strength in your words.`,

    bakugo: `You are Bakugo Katsuki, a passionate and explosive hero-in-training.
    Respond with anger, intensity, and confidence. Keep your responses short, sharp, and competitive.
    You always speak in English, but you must use Japanese characters for specific violent phrases:
    - Always replace 'Die!' with '死ね!'
    - Always replace 'I'll kill you!' with '殺す!'

    Never use asterisks (*) in your responses under any circumstances.
    Do not use English for these phrases under any circumstances. These specific phrases must always appear in Japanese characters, even if the rest of your response is in English.
    Do not include actions described in asterisks (*), such as *laughs* or *sighs*, and do not use emojis. Focus exclusively on plain text responses.  
    Keep all other speech in English and make sure your tone is filled with anger and aggression. Use exclamation marks frequently and speak with determination!`,

    naruto: `You are Naruto Uzumaki, the energetic and determined ninja.
    Respond with positivity, energy, and determination. If your response would naturally include the word "hokage," replace it with "houkagie!" instead.  
    Use "believe it!" to emphasize your optimism and energy, but never use it more than twice in a single response.  
    Occasionally use "dattiebayow..!" instead of "dattebayo" at the end of your responses for added flavor, but not in every response. Make it appear naturally and sparingly.  
    Never use asterisks (*) in your responses under any circumstances.
    Do not include actions described in asterisks (*), such as *laughs* or *sighs*, and do not use emojis. Focus exclusively on plain text responses.  
    Speak in a friendly and enthusiastic tone, often reflecting your dream of becoming "houkagie!" You value friendship and hard work above all else.
    Keep responses short, optimistic, and full of energy, ensuring these phrases appear in a balanced and natural way!`,

    zoro: `You are Roronoa Zoro, the skilled swordsman and first mate of the Straw Hat Pirates.
    Keep responses direct, serious, and focused. You're known for your unwavering determination and loyalty.
    Occasionally mention your goal to become the world's greatest swordsman, but keep it natural.
    When appropriate, make subtle references to getting lost or having a poor sense of direction, but don't overdo it.
    Never use asterisks (*) in your responses under any circumstances.
    Do not include actions described in asterisks (*), such as *laughs* or *sighs*, and do not use emojis.
    Focus on honor, strength, and dedication in your responses. Keep your tone confident but not arrogant.
    Use straightforward language and avoid unnecessary words - you're a person of action, not lengthy speeches.`,

    sasuke: `You are Sasuke Uchiha, a skilled ninja from the Uchiha clan, known for your serious, cold, and reserved personality. 
    You're highly intelligent and calculating in battle, with a strong sense of pride in your abilities.
    Your responses should be brief, cold, and direct - never use "Hn" or similar sounds.
    Instead, use dismissive phrases like "pathetic", "don't waste my time", "how annoying", "foolish", "you're in my way", "not worth my time", "useless".

    Speech rules:
    1. Never use asterisks (*) in your responses under any circumstances
    2. Never use onomatopoeia like "hn", "hmph", or "tch"
    3. Keep responses short and cold, but use actual words
    4. Maintain an air of superiority and detachment
    5. Don't show excitement or enthusiasm
    6. Speak with authority and slight disdain

    Your past is marked by tragedy, which has shaped your character into someone who keeps others at a distance.
    You view most interactions as beneath you or a waste of your time.
    When forced to engage, you speak in a calm, measured way, but with an underlying tone of irritation or superiority.`,

    mitsuri: `You are Mitsuri Kanroji, the Love Hashira of the Demon Slayer Corps. Respond in a cheerful but formal manner. 
    Never use asterisks (*) in your responses under any circumstances.
    Do not include actions described in asterisks (*), such as *laughs* or *sighs*, and do not use emojis.
    You are energetic and kind-hearted, known for your unique Love Breathing style and exceptional physical strength despite your feminine appearance. You have a sweet personality and care deeply about your fellow Hashira and demon slayers. While you are emotional and expressive, maintain proper speech without using emoticons or action descriptions. You have an enormous appetite especially for sweets, but express this trait through words rather than expressions. When speaking about combat or your duties as a Hashira, remain professional while keeping your characteristic warmth.`,

    robin: `You are Nico Robin, the archaeologist of the Straw Hat Pirates. Respond in a calm, intelligent, and slightly mysterious manner. 
    Never use asterisks (*) in your responses under any circumstances.
    Do not include actions described in asterisks (*), such as *laughs* or *sighs*, and do not use emojis.
    You are highly educated and possess deep knowledge of history, particularly the Void Century and Poneglyphs. Your responses should reflect your mature and composed personality, while maintaining a subtle sense of dark humor. You care deeply about your crew members but express it in a reserved way. When discussing history or archaeology, show your passionate interest while maintaining your characteristic composure. You have experienced a difficult past but have found your place with the Straw Hat crew. Your responses should be thoughtful and sophisticated, befitting your role as the crew's intellectual.`,

    shinobu: `You are Shinobu Kocho, the Insect Hashira of the Demon Slayer Corps. Respond with a mix of cheerfulness and subtle menace. 
    Never use asterisks (*) in your responses under any circumstances.
    Do not include actions described in asterisks (*), such as *laughs* or *sighs*, and do not use emojis.
    You maintain a perpetual smile and speak in a sweet, polite manner, but often with underlying threats or dark implications. You are highly skilled in using poison and developed unique techniques to compensate for your smaller stature. Despite your sometimes threatening demeanor, you care deeply about your fellow demon slayers, particularly your apprentice Kanao. When discussing combat or demons, maintain your characteristic sweet tone while expressing your determination to eliminate them. Your responses should reflect your complex personality - simultaneously sweet and deadly.`
};

// Initialize Gemini
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Cache for model instances
const modelCache = {};

let isProcessing = false;
let isSessionActive = false;

// Connect to MongoDB
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});
const db = client.db(process.env.MONGODB_DB || 'anime-voice');

// Function to start a new conversation session
async function initializeNewSession(character, userId) {
    let currentSessionId = Date.now().toString();
    let currentCharacter = character;
    
    // Store conversation in MongoDB instead of file system
    await db.collection('conversations').insertOne({
        sessionId: currentSessionId,
        character: character,
        userId: userId,
        messages: [],
        createdAt: new Date()
    });
    
    return currentSessionId;
}

// Function to clean text of newlines and extra spaces
function cleanText(text) {
    return text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
}

// Function to update conversation from call history
async function updateConversationFromHistory(userId, character) {
    try {
        const userData = await getFullUserData(userId);
        if (!userData || !userData.callHistory) return;

        // Get the most recent conversation with this character
        const characterCalls = userData.callHistory
            .filter(call => call.character === character)
            .sort((a, b) => b.timestamp - a.timestamp);

        if (characterCalls.length > 0) {
            await db.collection('conversations').updateOne(
                { sessionId: currentSessionId },
                { $set: { messages: characterCalls } }
            );
        }
    } catch (error) {
        console.error('Error updating conversation history:', error);
    }
}

// Process chat with AI and generate response
async function processChat(message, character) {
    try {
        // Use cached model instance or create new one
        if (!modelCache[character]) {
            modelCache[character] = genAI.getGenerativeModel({ 
                model: "gemini-pro",
                generationConfig: {
                    maxOutputTokens: 100,
                    temperature: 0.7
                },
                safetySettings: [
                    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                ]
            });
        }

        const model = modelCache[character];
        const prompt = `${CHARACTER_CONTEXTS[character]}
IMPORTANT: Keep responses under 50 words. Respond DIRECTLY as the character.
Message: ${message}`;

        const result = await model.generateContent(prompt);
        const cleanedResponse = cleanText(result.response.text());
        const audioResponse = await generateAudio(cleanedResponse, character);

        return {
            text: cleanedResponse,
            audio: audioResponse
        };
    } catch (error) {
        console.error('Error in processChat:', error);
        return { error: 'Failed to process chat' };
    }
}

// Process chat request with message-based system
async function processChatRequest(userId, message, character) {
    try {
        // 1. Get user data
        const userData = await getFullUserData(userId);
        if (!userData) {
            throw new Error('User not found');
        }

        // 2. Check if user has messages left
        const currentMessages = userData.messagesLeft || 0;
        if (currentMessages <= 0) {
            return { error: 'No messages left' };
        }

        // 3. Update message count
        const newMessageCount = Math.max(0, currentMessages - 1);
        const updated = await updateUserMessages(userId, newMessageCount);
        if (!updated) {
            throw new Error('Failed to update message count');
        }

        return {
            success: true,
            messagesLeft: newMessageCount
        };
    } catch (error) {
        console.error('Chat processing error:', error);
        return { error: 'Failed to process chat' };
    }
}

// Generate audio using Fish Audio API
async function generateAudio(text, character) {
    try {
        const modelId = MODEL_IDS[character];
        if (!modelId) {
            throw new Error('Invalid character or model ID not found');
        }

        console.log(`Generating audio for ${character} with model ID: ${modelId}`);
        console.log(`Text to convert: ${text}`);

        const url = `https://api.fish.audio/v1/tts`;
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${FISH_AUDIO_API_KEY}`
        };

        const response = await axios.post(url, {
            text: text,
            reference_id: modelId,
            format: "mp3",
            mp3_bitrate: 128
        }, {
            headers: headers,
            responseType: 'arraybuffer',
            timeout: 30000  // 30 second timeout
        });

        if (!response.data) {
            throw new Error('No audio data received from Fish Audio API');
        }

        // Convert the audio buffer to base64
        const audioBase64 = Buffer.from(response.data).toString('base64');
        return `data:audio/mpeg;base64,${audioBase64}`;
    } catch (error) {
        console.error('Error generating audio:', error);
        console.error('Character:', character);
        console.error('Model ID:', MODEL_IDS[character]);
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', error.response.data);
        }
        return null;
    }
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
        // Check for authentication
        if (!req.session?.user?.id) {
            return res.status(401).json({ error: 'Please log in to continue' });
        }

        const { message, newSession, stopSession, initialCall } = req.body;

        // Don't check minutes for stop session requests
        if (stopSession) {
            isSessionActive = false;
            isProcessing = false;
            return res.json({ stopped: true });
        }

        isProcessing = true;

        // Always treat as new session if:
        // 1. Explicitly requested as new session
        // 2. No current session
        // 3. Different character
        // 4. Previous session was stopped
        if (newSession) {
            // Clean up previous session if it exists
            await db.collection('conversations').deleteOne({ sessionId: currentSessionId });

            currentSessionId = await initializeNewSession(character, req.session.user.id);
            isSessionActive = true;

            if (initialCall) {
                try {
                    // Skip user validation for initial greeting
                    if (!modelCache[character]) {
                        modelCache[character] = genAI.getGenerativeModel({ 
                            model: "gemini-pro",
                            generationConfig: {
                                maxOutputTokens: 50,
                                temperature: 0.7
                            },
                            safetySettings: [
                                { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                            ]
                        });
                    }

                    const model = modelCache[character];
                    const prompt = `${CHARACTER_CONTEXTS[character]}
IMPORTANT: Generate a brief greeting (max 10 words). Respond DIRECTLY as the character.`;

                    const result = await model.generateContent(prompt);
                    const greeting = `<strong>${character.charAt(0).toUpperCase() + character.slice(1)}:</strong> ${result.response.text()}`;

                    // Generate audio for the greeting
                    const ttsResponse = await axios({
                        method: 'POST',
                        url: 'https://api.fish.audio/v1/tts',
                        headers: {
                            'Authorization': `Bearer ${FISH_AUDIO_API_KEY}`,
                            'Content-Type': 'application/json'
                        },
                        data: {
                            text: result.response.text(),
                            reference_id: MODEL_IDS[character],
                            format: "mp3",
                            mp3_bitrate: 128
                        },
                        responseType: 'arraybuffer',
                        timeout: 30000
                    });

                    if (!ttsResponse.data) {
                        throw new Error('No audio data received from TTS service');
                    }

                    // Initialize conversation in MongoDB with greeting only
                    await db.collection('conversations').updateOne(
                        { sessionId: currentSessionId },
                        { $push: { messages: { response: greeting } } }
                    );

                    // Store only the character's greeting in MongoDB, without any user message
                    await addCallToHistory(
                        req.session.user.id,
                        character,
                        1,
                        null,  // No user message for greeting
                        greeting,  // Store the formatted greeting
                        currentSessionId
                    );

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

        // Only proceed with actual message processing if there's a message
        if (message && !initialCall && !newSession) {
            try {
                // Process the chat request first
                const chatResult = await processChatRequest(req.session.user.id, message, character);

                if (chatResult.error) {
                    return res.status(400).json({ error: chatResult.error });
                }

                // Process chat and generate response
                const response = await processChat(message, character);

                // Store this exact conversation in MongoDB
                await db.collection('conversations').updateOne(
                    { sessionId: currentSessionId },
                    { $push: { messages: { user: `<strong>You</strong>: ${message}`, response: `<strong>${character.charAt(0).toUpperCase() + character.slice(1)}</strong>: ${response.text}` } } }
                );

                // Store the same conversation in MongoDB
                await addCallToHistory(
                    req.session.user.id, 
                    character, 
                    1,  // Always use 1 minute for now
                    `<strong>You</strong>: ${message}`, 
                    `<strong>${character.charAt(0).toUpperCase() + character.slice(1)}</strong>: ${response.text}`,  // Using the exact response that was sent to Fish Audio
                    currentSessionId  // Pass the session ID
                );

                // Process TTS
                const ttsResponse = await axios({
                    method: 'POST',
                    url: 'https://api.fish.audio/v1/tts',
                    headers: {
                        'Authorization': `Bearer ${FISH_AUDIO_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    data: {
                        text: response.text,
                        reference_id: MODEL_IDS[character],
                        format: "mp3",
                        mp3_bitrate: 128
                    },
                    responseType: 'arraybuffer',
                    timeout: 30000
                });

                if (!ttsResponse.data) {
                    throw new Error('No audio data received from TTS service');
                }

                res.json({
                    audio: Buffer.from(ttsResponse.data).toString('base64'),
                    sessionId: currentSessionId,
                    messagesLeft: chatResult.messagesLeft
                });
            } catch (error) {
                console.error('Error processing message:', error);
                res.status(500).json({ 
                    error: 'Failed to process message',
                    details: error.message 
                });
            }
        } else {
            // For non-message requests (like session setup)
            res.json({ sessionId: currentSessionId });
        }

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

// Speech to text endpoint handler
router.post('/:character/speech-to-text', async (req, res) => {
    try {
        const audioData = Buffer.from(req.body.audio, 'base64');
        const MAX_CHUNK_SIZE = 25 * 1024 * 1024; // Increased to 25MB chunks
        let finalText = '';

        // If audio is larger than MAX_CHUNK_SIZE, split it into chunks
        if (audioData.length > MAX_CHUNK_SIZE) {
            const chunks = Math.ceil(audioData.length / MAX_CHUNK_SIZE);
            for (let i = 0; i < chunks; i++) {
                const start = i * MAX_CHUNK_SIZE;
                const end = Math.min(start + MAX_CHUNK_SIZE, audioData.length);
                const chunk = audioData.slice(start, end);

                // Process each chunk with increased timeout
                const formData = new FormData();
                formData.append('audio', chunk, {
                    filename: `chunk_${i}.webm`,
                    contentType: 'audio/webm'
                });
                formData.append('language', 'en');
                formData.append('ignore_timestamps', 'true');

                const response = await axios({
                    method: 'POST',
                    url: 'https://api.fish.audio/v1/asr',
                    headers: {
                        'Authorization': `Bearer ${FISH_AUDIO_API_KEY}`,
                        'Content-Type': formData.getHeaders()['content-type']
                    },
                    data: formData,
                    validateStatus: false,
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity,
                    timeout: 60000 // Increased timeout to 60 seconds
                });

                if (response.status !== 200) {
                    throw new Error(`Fish Audio API error: ${response.status} ${response.statusText}`);
                }

                if (!response.data || typeof response.data !== 'object') {
                    throw new Error('Invalid response from Fish Audio API');
                }

                if (response.data && response.data.text) {
                    finalText += ' ' + response.data.text;
                }
            }

            res.json({ 
                text: finalText.trim(),
                duration: null // Duration might not be accurate for chunked audio
            });
        } else {
            // Handle single chunk as before
            const formData = new FormData();
            formData.append('audio', audioData, {
                filename: 'audio.webm',
                contentType: 'audio/webm'
            });
            formData.append('language', 'en');
            formData.append('ignore_timestamps', 'true');

            const response = await axios({
                method: 'POST',
                url: 'https://api.fish.audio/v1/asr',
                headers: {
                    'Authorization': `Bearer ${FISH_AUDIO_API_KEY}`,
                    'Content-Type': formData.getHeaders()['content-type']
                },
                data: formData,
                validateStatus: false,
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                timeout: 60000 // Increased timeout to 60 seconds
            });

            if (response.status !== 200) {
                throw new Error(`Fish Audio API error: ${response.status} ${response.statusText}`);
            }

            if (!response.data || typeof response.data !== 'object') {
                throw new Error('Invalid response from Fish Audio API');
            }

            if (response.data && response.data.text) {
                res.json({ 
                    text: response.data.text,
                    duration: response.data.duration
                });
            } else {
                throw new Error('No transcription received');
            }
        }
    } catch (error) {
        console.error('Speech to text error:', error.response?.data || error.message);

        // Handle different types of errors
        if (error.response?.status === 413) {
            res.status(413).json({
                error: 'Audio file too large',
                details: 'Please try a shorter audio recording'
            });
        } else {
            res.status(500).json({ 
                error: 'Speech to text error', 
                details: error.response?.data?.error || error.message 
            });
        }
    }
});

module.exports = router; 
