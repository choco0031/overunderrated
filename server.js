const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    // Mobile optimization settings
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(express.json());
app.use(express.static('public'));
// Serve images from the images directory
app.use('/images', express.static('images'));

// Game state storage
const lobbies = new Map();
const gameStates = new Map();
const disconnectedPlayers = new Map();

// Load images from directory
let gameImages = [];
const imagesDir = path.join(__dirname, 'images');

// Create images directory if it doesn't exist
if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir);
    console.log('Created images directory. Please add images to the images/ folder.');
}

// Function to load images
function loadImages() {
    try {
        const files = fs.readdirSync(imagesDir);
        gameImages = files
            .filter(file => {
                const ext = path.extname(file).toLowerCase();
                return ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
            })
            .map(file => `/images/${file}`);
        
        console.log(`Loaded ${gameImages.length} images from the images directory`);
        
        if (gameImages.length === 0) {
            console.warn('No images found in the images directory!');
            console.warn('Please add image files (jpg, jpeg, png, gif, webp) to the images/ folder');
        }
    } catch (error) {
        console.error('Error loading images:', error);
        gameImages = [];
    }
}

// Load images on startup
loadImages();

// Reload images every 5 minutes to pick up new additions
setInterval(loadImages, 5 * 60 * 1000);

// Helper function to generate lobby codes
function generateLobbyCode() {
    return Math.random().toString(36).substr(2, 6).toUpperCase();
}

// Helper function to sync game state to a player
function syncGameStateToPlayer(socketId, code) {
    const gameState = gameStates.get(code);
    const lobby = lobbies.get(code);
    
    if (!gameState || !lobby) return;
    
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) return;
    
    socket.emit('sync-game-state', {
        gameState: {
            phase: gameState.phase,
            roundNumber: gameState.roundNumber,
            currentImage: gameState.currentImage,
            timer: gameState.timer,
            scores: gameState.scores,
            voteResults: gameState.voteResults
        },
        lobby: lobby,
        userVote: gameState.votes[socket.username]
    });
}

// API Routes
app.post('/api/lobby/create', (req, res) => {
    const { username } = req.body;
    
    if (!username || username.length < 2) {
        return res.status(400).json({ error: 'Username must be at least 2 characters' });
    }
    
    const code = generateLobbyCode();
    const lobby = {
        code,
        host: username,
        participants: [{ username, isHost: true, connected: true }],
        createdAt: new Date(),
        gameStarted: false
    };
    
    lobbies.set(code, lobby);
    
    res.json({ code, lobby });
});

app.post('/api/lobby/join', (req, res) => {
    const { code, username } = req.body;
    
    if (!code || !username) {
        return res.status(400).json({ error: 'Code and username are required' });
    }
    
    const lobby = lobbies.get(code);
    if (!lobby) {
        return res.status(404).json({ error: 'Lobby not found' });
    }
    
    // Check if this is a reconnection
    const existingParticipant = lobby.participants.find(p => p.username === username);
    if (existingParticipant) {
        existingParticipant.connected = true;
        return res.json({ lobby, reconnection: true });
    }
    
    // Add new participant
    lobby.participants.push({ username, isHost: false, connected: true });
    
    // If game is active, initialize score for new player
    const gameState = gameStates.get(code);
    if (gameState) {
        gameState.scores[username] = 0;
    }
    
    res.json({ lobby });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    socket.on('join-lobby', (data) => {
        const { code, username } = data;
        socket.join(code);
        socket.username = username;
        socket.lobbyCode = code;
        
        const lobby = lobbies.get(code);
        if (lobby) {
            const participant = lobby.participants.find(p => p.username === username);
            if (participant) {
                participant.connected = true;
            }
            
            const gameState = gameStates.get(code);
            if (gameState && gameState.phase !== 'waiting') {
                setTimeout(() => {
                    syncGameStateToPlayer(socket.id, code);
                }, 1000);
            }
            
            io.to(code).emit('lobby-updated', lobby);
        }
    });
    
    socket.on('leave-lobby', (data) => {
        const { code, username } = data;
        const lobby = lobbies.get(code);
        const gameState = gameStates.get(code);
        
        if (lobby) {
            if (gameState && gameState.phase !== 'waiting') {
                const participant = lobby.participants.find(p => p.username === username);
                if (participant) {
                    participant.connected = false;
                    disconnectedPlayers.set(username, { code, timestamp: Date.now() });
                }
                io.to(code).emit('lobby-updated', lobby);
            } else {
                lobby.participants = lobby.participants.filter(p => p.username !== username);
                
                if (lobby.participants.length === 0 || username === lobby.host) {
                    lobbies.delete(code);
                    gameStates.delete(code);
                    io.to(code).emit('lobby-closed');
                } else {
                    io.to(code).emit('lobby-updated', lobby);
                }
            }
        }
        
        socket.leave(code);
    });
    
    socket.on('start-game', (data) => {
        const { code, username } = data;
        const lobby = lobbies.get(code);
        
        if (lobby && lobby.host === username && lobby.participants.length >= 2) {
            if (gameImages.length === 0) {
                socket.emit('error', { message: 'No images available. Please add images to the images/ folder' });
                return;
            }
            
            lobby.gameStarted = true;
            
            const gameState = {
                phase: 'discussion',
                roundNumber: 1,
                totalRounds: 30,
                currentImage: null,
                votes: {},
                scores: {},
                usedImages: [],
                timer: 60,
                timerInterval: null,
                voteResults: { overrated: 0, fairlyRated: 0, underrated: 0 }
            };
            
            // Initialize scores
            lobby.participants.forEach(participant => {
                gameState.scores[participant.username] = 0;
            });
            
            gameStates.set(code, gameState);
            
            io.to(code).emit('game-started', { lobby, gameState });
            
            setTimeout(() => {
                startDiscussionPhase(code);
            }, 2000);
        }
    });
    
    socket.on('cast-vote', (data) => {
        const { code, username, vote } = data;
        const gameState = gameStates.get(code);
        
        if (gameState && gameState.phase === 'voting' && !gameState.votes[username]) {
            gameState.votes[username] = vote;
            
            const lobby = lobbies.get(code);
            const connectedPlayers = lobby.participants.filter(p => p.connected);
            const votedPlayers = Object.keys(gameState.votes);
            
            // Never skip timer even if everyone voted
            console.log(`Vote cast by ${username}: ${vote}. ${votedPlayers.length}/${connectedPlayers.length} voted.`);
        }
    });
    
    socket.on('request-sync', (data) => {
        const { code } = data;
        syncGameStateToPlayer(socket.id, code);
    });
    
    socket.on('restart-game', (data) => {
        const { code } = data;
        const lobby = lobbies.get(code);
        const gameState = gameStates.get(code);
        
        if (lobby && gameState && socket.username === lobby.host) {
            if (gameImages.length === 0) {
                socket.emit('error', { message: 'No images available. Please add images to the images/ folder' });
                return;
            }
            
            gameState.phase = 'discussion';
            gameState.roundNumber = 1;
            gameState.currentImage = null;
            gameState.votes = {};
            gameState.usedImages = [];
            gameState.timer = 60;
            gameState.voteResults = { overrated: 0, fairlyRated: 0, underrated: 0 };
            
            lobby.participants.forEach(participant => {
                gameState.scores[participant.username] = 0;
            });
            
            if (gameState.timerInterval) {
                clearInterval(gameState.timerInterval);
            }
            
            io.to(code).emit('game-started', { lobby, gameState });
            
            setTimeout(() => {
                startDiscussionPhase(code);
            }, 2000);
        }
    });
    
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        if (socket.lobbyCode && socket.username) {
            const lobby = lobbies.get(socket.lobbyCode);
            const gameState = gameStates.get(socket.lobbyCode);
            
            if (lobby) {
                const participant = lobby.participants.find(p => p.username === socket.username);
                
                if (participant) {
                    if (gameState && gameState.phase !== 'waiting') {
                        participant.connected = false;
                        disconnectedPlayers.set(socket.username, { 
                            code: socket.lobbyCode, 
                            timestamp: Date.now() 
                        });
                        io.to(socket.lobbyCode).emit('lobby-updated', lobby);
                    } else {
                        lobby.participants = lobby.participants.filter(p => p.username !== socket.username);
                        
                        if (lobby.participants.length === 0 || socket.username === lobby.host) {
                            if (gameState && gameState.timerInterval) {
                                clearInterval(gameState.timerInterval);
                            }
                            
                            lobbies.delete(socket.lobbyCode);
                            gameStates.delete(socket.lobbyCode);
                            io.to(socket.lobbyCode).emit('lobby-closed');
                        } else {
                            io.to(socket.lobbyCode).emit('lobby-updated', lobby);
                        }
                    }
                }
            }
        }
    });
});

// Clean up old disconnected players
setInterval(() => {
    const now = Date.now();
    const timeout = 5 * 60 * 1000; // 5 minutes
    
    disconnectedPlayers.forEach((data, username) => {
        if (now - data.timestamp > timeout) {
            const lobby = lobbies.get(data.code);
            if (lobby) {
                lobby.participants = lobby.participants.filter(p => p.username !== username);
                io.to(data.code).emit('lobby-updated', lobby);
            }
            disconnectedPlayers.delete(username);
        }
    });
}, 60000);

// Game logic functions
function startDiscussionPhase(code) {
    const gameState = gameStates.get(code);
    const lobby = lobbies.get(code);
    
    if (!gameState || !lobby) return;
    
    // Select a random image that hasn't been used
    const availableImages = gameImages.filter((image, index) => 
        !gameState.usedImages.includes(index)
    );
    
    if (availableImages.length === 0 || gameState.roundNumber > gameState.totalRounds) {
        endGame(code);
        return;
    }
    
    const randomIndex = Math.floor(Math.random() * availableImages.length);
    const selectedImage = availableImages[randomIndex];
    const originalIndex = gameImages.indexOf(selectedImage);
    
    gameState.currentImage = selectedImage;
    gameState.usedImages.push(originalIndex);
    gameState.phase = 'discussion';
    gameState.votes = {};
    gameState.timer = 60;
    
    if (gameState.timerInterval) {
        clearInterval(gameState.timerInterval);
    }
    
    io.to(code).emit('image-selected', { imagePath: selectedImage });
    io.to(code).emit('game-phase-update', {
        phase: 'discussion',
        roundNumber: gameState.roundNumber
    });
    
    startTimer(code, 60, () => {
        startVotingPhase(code);
    });
}

function startVotingPhase(code) {
    const gameState = gameStates.get(code);
    
    if (!gameState) return;
    
    gameState.phase = 'voting';
    gameState.timer = 30;
    
    io.to(code).emit('game-phase-update', { phase: 'voting' });
    
    startTimer(code, 30, () => {
        calculateResults(code);
    });
}

function calculateResults(code) {
    const gameState = gameStates.get(code);
    const lobby = lobbies.get(code);
    
    if (!gameState || !lobby) return;
    
    // Count votes (only from connected players)
    const voteResults = { overrated: 0, fairlyRated: 0, underrated: 0 };
    
    lobby.participants.forEach(participant => {
        if (participant.connected) {
            const vote = gameState.votes[participant.username];
            if (vote === 'overrated') {
                voteResults.overrated++;
            } else if (vote === 'fairlyRated') {
                voteResults.fairlyRated++;
            } else if (vote === 'underrated') {
                voteResults.underrated++;
            }
        }
    });
    
    gameState.voteResults = { ...voteResults };
    
    // Determine majority option (highest vote count)
    let majorityOption = null;
    let maxVotes = 0;
    
    Object.entries(voteResults).forEach(([option, votes]) => {
        if (votes > maxVotes) {
            maxVotes = votes;
            majorityOption = option;
        } else if (votes === maxVotes && votes > 0) {
            // If there's a tie for the most votes, no majority
            majorityOption = null;
        }
    });
    
    // Award points to majority voters (as long as there's a clear winner, no >50% requirement)
    if (majorityOption) {
        lobby.participants.forEach(participant => {
            if (gameState.votes[participant.username] === majorityOption) {
                gameState.scores[participant.username] += 1;
            }
        });
    }
    
    gameState.phase = 'results';
    
    io.to(code).emit('game-phase-update', { phase: 'results' });
    io.to(code).emit('round-results', {
        votes: voteResults,
        majorityOption: majorityOption,
        currentImage: gameState.currentImage
    });
    
    setTimeout(() => {
        showScoreboard(code);
    }, 5000);
}

function showScoreboard(code) {
    const gameState = gameStates.get(code);
    
    if (!gameState) return;
    
    gameState.phase = 'scoreboard';
    
    io.to(code).emit('game-phase-update', { phase: 'scoreboard' });
    io.to(code).emit('scoreboard-update', { scores: gameState.scores });
    
    setTimeout(() => {
        gameState.roundNumber++;
        
        if (gameState.roundNumber > gameState.totalRounds || gameState.usedImages.length >= gameImages.length) {
            endGame(code);
        } else {
            gameState.phase = 'waiting';
            io.to(code).emit('game-phase-update', { phase: 'waiting' });
            
            setTimeout(() => {
                startDiscussionPhase(code);
            }, 3000);
        }
    }, 5000);
}

function endGame(code) {
    const gameState = gameStates.get(code);
    
    if (!gameState) return;
    
    if (gameState.timerInterval) {
        clearInterval(gameState.timerInterval);
    }
    
    io.to(code).emit('game-ended', {
        finalScores: gameState.scores
    });
}

function startTimer(code, seconds, callback) {
    const gameState = gameStates.get(code);
    if (!gameState) return;
    
    gameState.timer = seconds;
    
    if (gameState.timerInterval) {
        clearInterval(gameState.timerInterval);
    }
    
    gameState.timerInterval = setInterval(() => {
        gameState.timer--;
        io.to(code).emit('game-timer', { timeRemaining: gameState.timer });
        
        if (gameState.timer <= 0) {
            clearInterval(gameState.timerInterval);
            gameState.timerInterval = null;
            callback();
        }
    }, 1000);
}

// Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('OverUnderRated Game Server Started!');
    console.log('========================================');
    console.log(`Images folder: ${imagesDir}`);
    console.log(`Images loaded: ${gameImages.length}`);
    if (gameImages.length === 0) {
        console.log('\n⚠️  WARNING: No images found!');
        console.log('Please add image files to the images/ folder');
        console.log('Supported formats: .jpg, .jpeg, .png, .gif, .webp');
    }
    console.log('========================================');
});
