const { MongoClient, ObjectId, ServerApiVersion } = require('mongodb');

// MongoDB Connection String
const uri = "mongodb+srv://animevoice:5bijez5BGK8kmsUe@cluster0.aquqj.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

let db;

async function connectDB() {
    if (!db) {
        try {
            await client.connect();
            db = client.db("anime_voice");
            console.log("Successfully connected to MongoDB!");
            return db;
        } catch (error) {
            console.error("Error connecting to MongoDB:", error);
            throw error;
        }
    }
    return db;
}

// User data management functions
async function updateUserMinutes(userId, minutes) {
    try {
        await connectDB();
        const result = await db.collection('users').updateOne(
            { _id: new ObjectId(userId) },
            { 
                $set: { 
                    minutesLeft: minutes,
                    updatedAt: new Date()
                }
            }
        );
        return result.modifiedCount > 0;
    } catch (error) {
        console.error('Error updating user minutes:', error);
        throw new Error('Failed to update user minutes');
    }
}

async function getFullUserData(userId) {
    try {
        await connectDB();
        return await db.collection('users').findOne(
            { _id: new ObjectId(userId) },
            { 
                projection: {
                    password: 0 // Exclude password from the result
                }
            }
        );
    } catch (error) {
        console.error('Error fetching user data:', error);
        throw new Error('Failed to fetch user data');
    }
}

// Add call to user's history
async function addCallToHistory(userId, character, minutesUsed, userMessage, characterResponse, sessionId) {
    try {
        await connectDB();

        // Ensure minutesUsed is a number
        minutesUsed = parseInt(minutesUsed) || 1;

        const now = new Date();

        // Check if there's an existing conversation for this session
        const user = await db.collection('users').findOne(
            { 
                _id: new ObjectId(userId),
                'callHistory.sessionId': sessionId 
            },
            { projection: { 'callHistory.$': 1 } }
        );

        if (user && user.callHistory && user.callHistory[0]) {
            // Update existing conversation for this session
            const currentMinutesUsed = parseInt(user.callHistory[0].minutesUsed) || 0;

            const result = await db.collection('users').updateOne(
                { 
                    _id: new ObjectId(userId),
                    'callHistory.sessionId': sessionId
                },
                { 
                    $push: { 
                        'callHistory.$.messages': {
                            userMessage,
                            characterResponse,
                            timestamp: now
                        }
                    },
                    $set: {
                        'callHistory.$.minutesUsed': currentMinutesUsed + minutesUsed,
                        updatedAt: now
                    }
                }
            );
            return result.modifiedCount > 0;
        } else {
            // Create new conversation for this session
            const result = await db.collection('users').updateOne(
                { _id: new ObjectId(userId) },
                { 
                    $push: { 
                        callHistory: {
                            sessionId,
                            character,
                            minutesUsed: minutesUsed,
                            timestamp: now,
                            messages: [{
                                userMessage,
                                characterResponse,
                                timestamp: now
                            }]
                        }
                    },
                    $set: {
                        updatedAt: now
                    }
                }
            );
            return result.modifiedCount > 0;
        }
    } catch (error) {
        console.error('Error adding call to history:', error);
        throw new Error('Failed to add call to history');
    }
}

// Update user's remaining messages
async function updateUserMessages(userId, messages) {
    try {
        await connectDB();
        const result = await db.collection('users').updateOne(
            { _id: new ObjectId(userId) },
            { 
                $set: { 
                    messagesLeft: messages,
                    updatedAt: new Date()
                }
            }
        );
        return result.modifiedCount > 0;
    } catch (error) {
        console.error('Error updating user messages:', error);
        throw new Error('Failed to update user messages');
    }
}

// Check and reset user's daily messages
async function checkAndResetMessages(userId) {
    try {
        await connectDB();
        const user = await getFullUserData(userId);

        if (!user) {
            throw new Error('User not found');
        }

        const planLimits = {
            free: 10,
            premium: 50,
            ultimate: -1 // Unlimited
        };

        const userPlan = user.currentPlan || 'free';
        const dailyLimit = planLimits[userPlan];

        // If messagesLeft is undefined or it's time to reset
        const lastReset = user.lastMessageReset || new Date(0);
        const now = new Date();
        const isNewDay = lastReset.getDate() !== now.getDate() || 
                        lastReset.getMonth() !== now.getMonth() || 
                        lastReset.getFullYear() !== now.getFullYear();

        if (typeof user.messagesLeft === 'undefined' || isNewDay) {
            await db.collection('users').updateOne(
                { _id: new ObjectId(userId) },
                { 
                    $set: { 
                        messagesLeft: dailyLimit,
                        lastMessageReset: now,
                        updatedAt: now
                    }
                }
            );
            return dailyLimit;
        }

        return user.messagesLeft;
    } catch (error) {
        console.error('Error checking messages:', error);
        throw error;
    }
}

module.exports = {
    updateUserMinutes,
    getFullUserData,
    addCallToHistory,
    updateUserMessages,
    checkAndResetMessages
};
