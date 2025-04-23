// --- START OF FILE server.js ---

// server.js
const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 8080 });

let players = {}; // { id: { x, y, z, pitch, yaw, health, ammo, magazine, name, kills, deaths, lastUpdateTime, reloading, reloadStartTime } }
let projectiles = []; // { id, x, y, z, vx, vy, vz, ownerId, spawnTime }
let projectileIdCounter = 0;
let clientMap = new Map(); // Map<playerId, WebSocket>

// --- Constants ---
const START_HEALTH = 100;
const START_AMMO = 100; // Initial reserve ammo
const START_MAGAZINE = 30; // Max magazine capacity
const RELOAD_DURATION = 2000; // ms
const PLAYER_RADIUS = 0.4; // Radius for player-player physics/collision
const PLAYER_HITBOX_RADIUS = 0.6; // Radius for projectile hit detection (can be larger than physical radius)
const PLAYER_HEIGHT = 1.8;
const PROJECTILE_SPEED = 50;
const PROJECTILE_DAMAGE = 10; // 1 hit = 1 heart (10 damage per hit)
const PROJECTILE_LIFETIME = 2000; // ms
const RESPAWN_TIME = 3000; // ms - 3 seconds
const INACTIVITY_TIMEOUT = 30000; // ms (30 seconds)
const TICK_RATE = 30; // Target ticks per second

console.log(`WebSocket Server listening on port 8080 (Tick Rate: ${TICK_RATE} Hz)`);

wss.on('connection', (ws) => {
    const playerId = generateUniqueId();
    const playerName = `Player_${playerId.substring(0, 4)}`;
    console.log(`Player ${playerName} (${playerId}) connected.`);

    // Initialize player state
    players[playerId] = {
        id: playerId,
        name: playerName,
        x: Math.random() * 10 - 5, // Random initial position
        y: 1.6, // Initial Y position (approx eye level, client corrects on first update)
        z: Math.random() * 10 - 5,
        pitch: 0,
        yaw: 0,
        health: START_HEALTH,
        ammo: START_AMMO, // Start with full reserve ammo
        magazine: START_MAGAZINE, // Start with full magazine
        kills: 0,
        deaths: 0,
        reloading: false,
        reloadStartTime: 0,
        lastUpdateTime: Date.now()
    };
    clientMap.set(playerId, ws); // Map player ID to WebSocket instance

    // Send initial state ('init') to the new player
    // Includes their ID, current state of all players, and active projectiles
    ws.send(JSON.stringify({
        type: 'init',
        payload: {
            id: playerId,
            players: players, // Send snapshot of all players
            projectiles: projectiles.map(p => ({ ...p, type: 'projectile' })) // Send snapshot of active projectiles
        }
    }));

    // Inform *other* players about the new player joining
    broadcast({
        type: 'player_joined',
        payload: { ...players[playerId] } // Send the full initial state of the new player
    }, ws); // Exclude the new player itself from this broadcast

    // Handle messages received from the client
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const player = players[playerId]; // Get the player data associated with this WebSocket connection

            // If player doesn't exist (e.g., disconnected shortly after message sent), ignore
            if (!player) {
                console.warn(`Received message from non-existent player ${playerId}`);
                return;
            }

            // Update last active time
            player.lastUpdateTime = Date.now();

            // Ignore most actions if the player is dead (health <= 0)
            // Allow specific messages like chat or potentially a manual respawn request later
            if (player.health <= 0 && !['request_respawn', 'chat_message'].includes(data.type)) {
                 // Note: Player can't currently request respawn, it happens automatically via timeout
                return;
            }

            // Process message based on its type
            switch (data.type) {
                case 'player_update':
                    // Validate position and rotation data before applying
                    if (isValidPosition(data.payload.position) && isValidRotation(data.payload.rotation)) {
                        player.x = data.payload.position.x;
                        // Trust client's Y position (eye level)
                        player.y = data.payload.position.y;
                        player.z = data.payload.position.z;
                        player.pitch = data.payload.rotation.pitch;
                        player.yaw = data.payload.rotation.yaw;
                    } else {
                        console.warn(`Invalid player_update data received from ${player.name}`);
                    }
                    break;

                case 'shoot':
                    // Allow shooting only if alive, not reloading, and has ammo in magazine
                    if (player.health > 0 && !player.reloading && player.magazine > 0) {
                        player.magazine--; // Consume one bullet from magazine

                        // Create a new projectile
                        const projectileId = `proj_${projectileIdCounter++}`;
                        const direction = data.payload.direction; // Get direction from client
                        const startPos = data.payload.startPos;   // Get start position from client

                        // Basic validation for shoot data (optional but recommended)
                         if (!isValidPosition(startPos) || !isValidDirection(direction)) {
                             console.warn(`Invalid shoot data received from ${player.name}`);
                             break; // Don't create projectile if data is bad
                         }

                        const newProjectile = {
                            id: projectileId,
                            ownerId: playerId, // ID of the player who shot
                            spawnTime: Date.now(),
                            x: startPos.x, y: startPos.y, z: startPos.z,
                            // Calculate velocity based on direction and speed
                            vx: direction.x * PROJECTILE_SPEED,
                            vy: direction.y * PROJECTILE_SPEED,
                            vz: direction.z * PROJECTILE_SPEED,
                        };
                        projectiles.push(newProjectile); // Add to the list of active projectiles

                        // Broadcast the creation of the projectile to all clients
                        broadcast({ type: 'projectile_created', payload: { ...newProjectile } });

                        // Send an ammo update *only* to the shooter to confirm the shot
                        ws.send(JSON.stringify({ type: 'ammo_update', payload: { magazine: player.magazine, ammo: player.ammo } }));
                    }
                    break;

                case 'request_reload':
                    // Allow reload only if alive, not already reloading, magazine not full, and has reserve ammo
                    if (player.health > 0 && !player.reloading && player.magazine < START_MAGAZINE && player.ammo > 0) {
                        console.log(`Player ${player.name} starting reload.`);
                        player.reloading = true;
                        player.reloadStartTime = Date.now();

                        // Use setTimeout to handle reload completion after RELOAD_DURATION
                        setTimeout(() => {
                            const currentPlayer = players[playerId]; // Re-fetch player data in case they disconnected during reload
                            // Check if player still exists and is *still* the one reloading (wasn't interrupted, e.g., by death)
                            if (currentPlayer && currentPlayer.reloading && currentPlayer.reloadStartTime === player.reloadStartTime) { // Check start time match
                                const ammoNeeded = START_MAGAZINE - currentPlayer.magazine; // How many bullets fit
                                const ammoToMove = Math.min(ammoNeeded, currentPlayer.ammo); // How many bullets available

                                // Update ammo counts
                                currentPlayer.magazine += ammoToMove;
                                currentPlayer.ammo -= ammoToMove;
                                currentPlayer.reloading = false; // Finish reloading state
                                console.log(`Player ${currentPlayer.name} finished reload. Ammo: ${currentPlayer.magazine}/${currentPlayer.ammo}`);

                                // Send the final ammo update to the reloaded player
                                const playerWs = clientMap.get(playerId);
                                if (playerWs && playerWs.readyState === WebSocket.OPEN) {
                                    playerWs.send(JSON.stringify({ type: 'ammo_update', payload: { magazine: currentPlayer.magazine, ammo: currentPlayer.ammo } }));
                                }
                            } else {
                                // Reload was cancelled (e.g. player died or disconnected)
                                console.log(`Reload cancelled for player ${playerId}`);
                            }
                        }, RELOAD_DURATION);
                    }
                    break;
                 // Add other message types here if needed (e.g., chat)
            }
        } catch (error) {
            const playerNameForError = players[playerId]?.name || playerId; // Get player name if available
            console.error(`Error processing message from ${playerNameForError}:`, error, "Message:", message.toString());
        }
    });

    // Handle client disconnection
    ws.on('close', () => {
        handleDisconnect(playerId, playerName, "disconnected");
    });

    // Handle WebSocket errors
    ws.on('error', (error) => {
        console.error(`WebSocket error for player ${playerName} (${playerId}):`, error);
        handleDisconnect(playerId, playerName, "encountered an error"); // Treat error as disconnect
    });
});

// --- Main Game Loop ---
let lastTickTime = Date.now();
setInterval(() => {
    const now = Date.now();
    // Calculate delta time in seconds, capping to prevent large jumps if server hangs
    const deltaTime = Math.min((now - lastTickTime) / 1000.0, 0.1);
    lastTickTime = now;

    // Arrays to store events that happened during this tick
    const hitEvents = [];
    const expiredProjectiles = [];
    const deathEvents = [];

    // --- 1. Update Projectiles and Check Collisions ---
    projectiles = projectiles.filter(p => { // Filter keeps projectiles that should remain active
        // Update projectile position based on velocity and delta time
        p.x += p.vx * deltaTime;
        p.y += p.vy * deltaTime;
        p.z += p.vz * deltaTime;

        // Check if projectile lifetime expired or went out of bounds (e.g., fell through floor)
        if (now - p.spawnTime > PROJECTILE_LIFETIME || p.y < -5) { // Lower bounds check
            expiredProjectiles.push(p.id); // Add ID to list for removal notification
            return false; // Remove projectile from the main list
        }

        // Check collision against all players
        for (const targetId in players) {
            if (p.ownerId === targetId) continue; // Projectile shouldn't hit its owner
            const target = players[targetId];
            // Skip collision check if target doesn't exist or is already dead
            if (!target || target.health <= 0) continue;

            // --- Collision Detection Logic ---
            // Calculate vector difference between projectile and target's position (eye level)
            const dx = p.x - target.x;
            const dy = p.y - target.y; // Compare projectile Y with target's reported Y (eye level)
            const dz = p.z - target.z;

            // Check if projectile is within the vertical range of the player model
            // Player model spans roughly from (target.y - eyeLevel) to (target.y + (playerHeight - eyeLevel))
            // Approximate this check relative to the target's reported y (eye level)
            // Is projectile y within +/- (PLAYER_HEIGHT / 2) of target's y? Add a small buffer.
            const verticalHit = Math.abs(dy) < (PLAYER_HEIGHT / 2) + 0.2; // Generous vertical check

            // Check horizontal distance (XZ plane) using squared distance for efficiency
            const horizontalDistSq = dx * dx + dz * dz;
            const horizontalHit = horizontalDistSq < (PLAYER_HITBOX_RADIUS ** 2); // Use hitbox radius

            // If hit both vertically and horizontally
            if (verticalHit && horizontalHit) {
                target.health -= PROJECTILE_DAMAGE; // Apply damage
                expiredProjectiles.push(p.id); // Mark projectile for removal after hit

                const attacker = players[p.ownerId]; // Get attacker data
                const attackerName = attacker?.name || 'Unknown'; // Get attacker name

                // Record the hit event
                hitEvents.push({
                    targetId: targetId,
                    newHealth: target.health, // Send the health *after* damage
                    attackerId: p.ownerId,
                    attackerName: attackerName
                });

                console.log(`Player ${target.name} hit by ${attackerName}. Health: ${target.health}`);

                // --- Check for Death ---
                if (target.health <= 0) {
                    target.health = 0; // Ensure health doesn't go negative
                    target.deaths++; // Increment deaths for the target
                    target.reloading = false; // Cancel any active reload on death
                    console.log(`Player ${target.name} defeated by ${attackerName}.`);

                    // Record the death event
                    deathEvents.push({
                        victimId: targetId,
                        victimName: target.name,
                        attackerId: p.ownerId,
                        attackerName: attackerName
                    });

                    // Award kill to the attacker (if not self-inflicted)
                    if (attacker && attacker.id !== targetId) {
                        attacker.kills++;
                    }

                    // Log updated stats
                    console.log(`Stats ${target.name}: ${target.kills} K / ${target.deaths} D`);
                    if (attacker) {
                        console.log(`Stats ${attacker.name}: ${attacker.kills} K / ${attacker.deaths} D`);
                    }

                    // Schedule the player's respawn after RESPAWN_TIME
                    setTimeout(() => respawnPlayer(targetId), RESPAWN_TIME);
                }
                return false; // Remove projectile from list after hit
            }
        }
        return true; // Keep projectile if no hit occurred this tick
    });

    // --- 2. Broadcast Game State ---
    // Prepare the payload containing all updates for this tick
    const gameStatePayload = {
        players: players, // Send the current state of all players
        hits: hitEvents, // Send info about hits that occurred this tick
        deaths: deathEvents, // Send info about deaths this tick
        removedProjectiles: expiredProjectiles // Send IDs of projectiles removed this tick
    };

    // Only broadcast if there's something to update (players exist or events occurred)
    if (Object.keys(players).length > 0 || hitEvents.length > 0 || deathEvents.length > 0 || expiredProjectiles.length > 0) {
        broadcast({ type: 'game_state', payload: gameStatePayload });
    }


    // --- 3. Check for Inactive Players ---
    for (const playerId in players) {
        // If player hasn't sent an update in a while
        if (now - players[playerId].lastUpdateTime > INACTIVITY_TIMEOUT) {
            const wsInstance = clientMap.get(playerId);
            const playerName = players[playerId]?.name || playerId;
            if (wsInstance) {
                console.log(`Disconnecting inactive player ${playerName}.`);
                wsInstance.terminate(); // Force close the connection
                 // The 'close' event listener will trigger handleDisconnect
            } else {
                // If somehow wsInstance is gone but player data remains (shouldn't happen often)
                handleDisconnect(playerId, playerName, "removed due to inactivity (no WS found)");
            }
        }
    }

}, 1000 / TICK_RATE); // Run the game loop at the target tick rate

// --- Helper Functions ---

function respawnPlayer(playerId) {
    const player = players[playerId];
    if (player) {
        // Only respawn if the player is actually dead (health <= 0)
        // Prevents accidental respawn if the timeout fires after they somehow got health back
        if (player.health <= 0) {
             console.log(`Respawning player ${player.name}`);
             // Reset position to a random spot
             player.x = Math.random() * 10 - 5;
             player.y = 1.6; // Reset Y to approx eye level
             player.z = Math.random() * 10 - 5;
             // Reset stats
             player.health = START_HEALTH;
             player.magazine = START_MAGAZINE;
             player.ammo = START_AMMO; // Give full reserve ammo on respawn
             player.reloading = false; // Ensure not reloading
             player.lastUpdateTime = Date.now(); // Update timestamp

             // Broadcast the respawn event so clients can update the player's state/visibility
             broadcast({
                 type: 'player_respawned',
                 payload: {
                     id: playerId,
                     x: player.x, y: player.y, z: player.z, // Send new position
                     health: player.health,
                     magazine: player.magazine, ammo: player.ammo // Send new ammo state
                 }
             });
        } else {
             console.log(`Respawn called for player ${player.name}, but they are not dead (Health: ${player.health}). Skipping.`);
        }
    } else {
        // This might happen if the player disconnected right before the respawn timer fired
        console.log(`Attempted to respawn player ${playerId}, but they no longer exist.`);
    }
}


function handleDisconnect(playerId, playerName, reason) {
    console.log(`Player ${playerName || playerId} ${reason}.`);
    const disconnectedPlayerName = players[playerId]?.name; // Get name before deleting player data
    // Remove player data from the main state object
    if (players[playerId]) {
        delete players[playerId];
    }
    // Remove player's WebSocket mapping
    clientMap.delete(playerId);
    // Broadcast to remaining players that this player left
    broadcast({
        type: 'player_left',
        payload: { id: playerId, name: disconnectedPlayerName || 'Unknown' }
    });
     // Log current player count
     console.log(`Remaining players: ${Object.keys(players).length}`);
}

function broadcast(message, senderWs = null) {
    const messageString = JSON.stringify(message);
    // Iterate over the clientMap's values (WebSocket instances)
    clientMap.forEach((client) => {
        // Send to all clients *except* the sender (if specified) and only if connection is open
        if (client !== senderWs && client.readyState === WebSocket.OPEN) {
            try {
                client.send(messageString);
            } catch (error) {
                console.error("Error broadcasting message to a client:", error);
                 // Optional: Consider triggering disconnect for clients that cause errors on send
                 // findKeyByValue(clientMap, client).then(id => handleDisconnect(id, 'unknown', 'send error'));
            }
        }
    });
}

// Utility to find key by value in Map (needed for error handling in broadcast)
async function findKeyByValue(map, value) {
     for (let [key, val] of map.entries()) {
         if (val === value) {
             return key;
         }
     }
     return null; // Or undefined
}


function generateUniqueId() {
    // Simple pseudo-random ID generator
    return Math.random().toString(36).substring(2, 15);
}

// --- Basic Validation Functions ---
function isValidPosition(pos) {
     // Check if it's a non-null object with finite number properties x, y, z
     return typeof pos === 'object' && pos !== null &&
            typeof pos.x === 'number' && !isNaN(pos.x) && isFinite(pos.x) &&
            typeof pos.y === 'number' && !isNaN(pos.y) && isFinite(pos.y) &&
            typeof pos.z === 'number' && !isNaN(pos.z) && isFinite(pos.z);
 }
function isValidRotation(rot) {
     // Check if it's a non-null object with finite number properties pitch, yaw
     return typeof rot === 'object' && rot !== null &&
            typeof rot.pitch === 'number' && !isNaN(rot.pitch) && isFinite(rot.pitch) &&
            typeof rot.yaw === 'number' && !isNaN(rot.yaw) && isFinite(rot.yaw);
 }
 function isValidDirection(dir) {
     // Check if it's a non-null object with finite number properties x, y, z
     // Optional: Check if it's normalized (length approx 1) for extra safety
     return typeof dir === 'object' && dir !== null &&
            typeof dir.x === 'number' && !isNaN(dir.x) && isFinite(dir.x) &&
            typeof dir.y === 'number' && !isNaN(dir.y) && isFinite(dir.y) &&
            typeof dir.z === 'number' && !isNaN(dir.z) && isFinite(dir.z);
            // Optional normalization check:
            // const lenSq = dir.x*dir.x + dir.y*dir.y + dir.z*dir.z;
            // return lenSq > 0.9 && lenSq < 1.1;
 }

// --- END OF FILE server.js ---