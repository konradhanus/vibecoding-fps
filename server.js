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
const START_AMMO = 100;
const START_MAGAZINE = 30; // Maksymalna pojemność magazynka
const RELOAD_DURATION = 2000; // ms - czas przeładowania
const PLAYER_RADIUS = 0.4; // Radius for player-player physics/collision
const PLAYER_HITBOX_RADIUS = 0.6; // Radius for projectile hit detection (larger than physics radius)
const PLAYER_HEIGHT = 1.8;
const PROJECTILE_SPEED = 50;
const PROJECTILE_DAMAGE = 10; // Damage per hit (1 hit = 1 heart)
const PROJECTILE_LIFETIME = 2000; // ms
const RESPAWN_TIME = 3000; // ms - 3 seconds
const INACTIVITY_TIMEOUT = 30000; // ms

console.log("Serwer WebSocket nasłuchuje na porcie 8080");

wss.on('connection', (ws) => {
    const playerId = generateUniqueId();
    const playerName = `Gracz_${playerId.substring(0, 4)}`;
    console.log(`Gracz ${playerName} (${playerId}) połączył się.`);

    // Initialize player state
    players[playerId] = {
        id: playerId,
        name: playerName,
        x: Math.random() * 10 - 5,
        y: 1, // Position of player's "feet"
        z: Math.random() * 10 - 5,
        pitch: 0,
        yaw: 0,
        health: START_HEALTH,
        ammo: START_AMMO,
        magazine: START_MAGAZINE,
        kills: 0,
        deaths: 0,
        reloading: false,
        reloadStartTime: 0,
        lastUpdateTime: Date.now()
    };
    clientMap.set(playerId, ws);

    // Send initial state to the new player
    ws.send(JSON.stringify({
        type: 'init',
        payload: {
            id: playerId,
            players: players,
            projectiles: projectiles.map(p => ({ ...p, type: 'projectile' })) // Send existing projectiles
        }
    }));

    // Inform other players about the new player
    broadcast({
        type: 'player_joined',
        payload: { id: playerId, name: playerName, ...players[playerId] } // Send full data
    }, ws); // Send to everyone except the new player

    // Handle messages from the client
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const player = players[playerId];

            if (!player) {
                console.warn(`Received message from non-existent player ${playerId}`);
                return;
            }

            player.lastUpdateTime = Date.now(); // Update activity time

            // Ignore most messages if player is dead
            if (player.health <= 0 && !['request_respawn', 'chat_message'].includes(data.type)) {
                return;
            }

            switch (data.type) {
                case 'player_update':
                    if (isValidPosition(data.payload.position) && isValidRotation(data.payload.rotation)) {
                        player.x = data.payload.position.x;
                        player.y = 1.0; // Server dictates Y position
                        player.z = data.payload.position.z;
                        player.pitch = data.payload.rotation.pitch;
                        player.yaw = data.payload.rotation.yaw;
                    }
                    break;
                case 'shoot':
                    // Allow shooting only if alive, not reloading, and has ammo in magazine
                    if (player.health > 0 && !player.reloading && player.magazine > 0) {
                        player.magazine--;
                        const projectileId = `proj_${projectileIdCounter++}`;
                        const direction = data.payload.direction;
                        const startPos = data.payload.startPos;
                        const newProjectile = {
                            id: projectileId, ownerId: playerId, spawnTime: Date.now(),
                            x: startPos.x, y: startPos.y, z: startPos.z,
                            vx: direction.x * PROJECTILE_SPEED,
                            vy: direction.y * PROJECTILE_SPEED,
                            vz: direction.z * PROJECTILE_SPEED,
                        };
                        projectiles.push(newProjectile);
                        // Inform all clients about the new projectile
                        broadcast({ type: 'projectile_created', payload: { ...newProjectile, type: 'projectile' } });
                        // Send ammo update only to the shooter
                        ws.send(JSON.stringify({ type: 'ammo_update', payload: { magazine: player.magazine, ammo: player.ammo } }));
                    }
                    break;
                case 'request_reload':
                    // Allow reload if alive, not reloading, magazine not full, and has reserve ammo
                    if (player.health > 0 && !player.reloading && player.magazine < START_MAGAZINE && player.ammo > 0) {
                        console.log(`Player ${player.name} starting reload.`);
                        player.reloading = true;
                        player.reloadStartTime = Date.now();

                        // Complete reload after RELOAD_DURATION
                        setTimeout(() => {
                            // Double-check if player still exists and is still reloading
                            const currentPlayer = players[playerId];
                            if (currentPlayer && currentPlayer.reloading) {
                                const ammoNeeded = START_MAGAZINE - currentPlayer.magazine;
                                const ammoToMove = Math.min(ammoNeeded, currentPlayer.ammo);

                                currentPlayer.magazine += ammoToMove;
                                currentPlayer.ammo -= ammoToMove;
                                currentPlayer.reloading = false;

                                console.log(`Player ${currentPlayer.name} finished reload. Ammo: ${currentPlayer.magazine}/${currentPlayer.ammo}`);

                                // Send ammo update to the reloading client
                                const playerWs = clientMap.get(playerId);
                                if (playerWs && playerWs.readyState === WebSocket.OPEN) {
                                    playerWs.send(JSON.stringify({ type: 'ammo_update', payload: { magazine: currentPlayer.magazine, ammo: currentPlayer.ammo } }));
                                }
                            }
                        }, RELOAD_DURATION);
                    }
                    break;
                // Add other message types like 'chat_message' here
            }
        } catch (error) {
            const playerNameForError = players[playerId]?.name || playerId;
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
        // handleDisconnect is usually called after 'error' via 'close', but ensure cleanup
        handleDisconnect(playerId, playerName, "encountered an error");
    });
});

// Main game loop
let lastTickTime = Date.now();
setInterval(() => {
    const now = Date.now();
    // Clamp deltaTime to avoid large jumps on lag/pause
    const deltaTime = Math.min((now - lastTickTime) / 1000.0, 0.1);
    lastTickTime = now;

    const hitEvents = [];
    const expiredProjectiles = [];
    const deathEvents = [];

    // 1. Update projectiles and check collisions
    projectiles = projectiles.filter(p => {
        // Move projectile
        p.x += p.vx * deltaTime;
        p.y += p.vy * deltaTime;
        p.z += p.vz * deltaTime;

        // Check lifetime or out of bounds (simple Y check)
        if (now - p.spawnTime > PROJECTILE_LIFETIME || p.y < -1) {
            expiredProjectiles.push(p.id);
            return false; // Remove projectile
        }

        // Check collisions with players
        for (const targetId in players) {
            if (p.ownerId === targetId) continue; // Cannot shoot self
            const target = players[targetId];
            if (!target || target.health <= 0) continue; // Skip dead or non-existent targets

            // --- Collision Detection ---
            // Calculate distance from projectile to the center of the player's hitbox
            const dx = p.x - target.x;
            // Check vertical distance relative to the player's height center (feet at y=1)
            const dy = p.y - (target.y + PLAYER_HEIGHT / 2);
            const dz = p.z - target.z;
            const distSq = dx * dx + dy * dy + dz * dz;

            // Use the larger hitbox radius for hit detection
            // Projectile radius is considered very small (e.g., 0.1)
            const collisionThresholdSq = (PLAYER_HITBOX_RADIUS + 0.1) * (PLAYER_HITBOX_RADIUS + 0.1);

             // console.log(`[Collision Check] Proj ${p.id} vs Player ${target.id} | distSq: ${distSq.toFixed(2)}, thresholdSq: ${collisionThresholdSq.toFixed(2)}`); // DEBUG LOG

            if (distSq < collisionThresholdSq) {
                 // console.log(`!!! HIT REGISTERED !!! Proj ${p.id} hit ${target.name} (${target.id}). Health before: ${target.health}`); // DEBUG LOG

                // Hit!
                target.health -= PROJECTILE_DAMAGE;
                expiredProjectiles.push(p.id); // Projectile disappears on hit

                 // console.log(`    Health after: ${target.health}`); // DEBUG LOG

                const attacker = players[p.ownerId];
                const attackerName = attacker?.name || 'Unknown';

                // Record hit event
                hitEvents.push({
                    targetId: targetId,
                    newHealth: target.health, // Send the new health value
                    attackerId: p.ownerId,
                    attackerName: attackerName // Include attacker's name
                });

                console.log(`Player ${target.name} hit by ${attackerName}. Health: ${target.health}`);

                // Check if target died
                if (target.health <= 0) {
                    target.health = 0; // Prevent negative health
                    target.deaths++;
                    target.reloading = false; // Cancel reload on death
                    console.log(`Player ${target.name} defeated by ${attackerName}.`);

                    // Record death event
                    deathEvents.push({
                        victimId: targetId,
                        victimName: target.name,
                        attackerId: p.ownerId,
                        attackerName: attackerName // Include names
                    });

                    // Award kill to attacker (if attacker exists and not self-kill)
                    if (attacker && attacker.id !== targetId) {
                        attacker.kills++;
                    }

                    // Log stats
                    console.log(`Stats ${target.name}: ${target.kills} K / ${target.deaths} D`);
                    if (attacker) {
                        console.log(`Stats ${attacker.name}: ${attacker.kills} K / ${attacker.deaths} D`);
                    }

                    // Schedule respawn
                    setTimeout(() => respawnPlayer(targetId), RESPAWN_TIME);
                }
                return false; // Projectile hit, remove it
            }
        }
        return true; // Keep projectile if no hit or expiration
    });

    // 2. Broadcast game state
    const gameState = {
        type: 'game_state',
        payload: {
            players: players, // Send full player data (including K/D, reloading status)
            hits: hitEvents, // Include hit events
            deaths: deathEvents, // Send death events with names
            removedProjectiles: expiredProjectiles // Send IDs of projectiles to remove
        }
    };
    broadcast(gameState);

    // 3. Check for inactive players
    for (const playerId in players) {
        if (now - players[playerId].lastUpdateTime > INACTIVITY_TIMEOUT) {
            const wsInstance = clientMap.get(playerId);
            const playerName = players[playerId]?.name || playerId;
            if (wsInstance) {
                console.log(`Disconnecting inactive player ${playerName}.`);
                wsInstance.close(); // Closing WS triggers 'close' event and handleDisconnect
            } else {
                // Handle rare case where player is in list but not in WS map
                handleDisconnect(playerId, playerName, "removed due to inactivity (no WS)");
            }
        }
    }

}, 1000 / 30); // Update rate ~30 Hz

function respawnPlayer(playerId) {
    const player = players[playerId];
    if (player) { // Check if player still exists (might have disconnected)
        console.log(`Respawning player ${player.name}`);
        // Reset state and position
        player.x = Math.random() * 10 - 5;
        player.y = 1;
        player.z = Math.random() * 10 - 5;
        player.health = START_HEALTH;
        player.magazine = START_MAGAZINE;
        player.ammo = START_AMMO;
        player.reloading = false; // Ensure not reloading on respawn
        // Kills and deaths are persistent
        player.lastUpdateTime = Date.now(); // Update activity time

        // Inform all players about the respawn
        broadcast({
            type: 'player_respawned',
            payload: {
                id: playerId,
                x: player.x, y: player.y, z: player.z,
                health: player.health,
                magazine: player.magazine, ammo: player.ammo
            }
        });
    } else {
        console.log(`Attempted to respawn player ${playerId}, but they no longer exist.`);
    }
}

function handleDisconnect(playerId, playerName, reason) {
    console.log(`Player ${playerName || playerId} ${reason}.`);
    const disconnectedPlayerName = players[playerId]?.name; // Get name before deleting
    if (players[playerId]) {
        delete players[playerId]; // Remove from player state
    }
    clientMap.delete(playerId); // Remove WebSocket mapping
    // Inform remaining players
    broadcast({
        type: 'player_left',
        payload: { id: playerId, name: disconnectedPlayerName || 'Unknown' } // Send name if available
    });
}

// Helper function to broadcast messages to all connected clients
function broadcast(message, senderWs = null) {
    const messageString = JSON.stringify(message);
    wss.clients.forEach((client) => {
        // Send to clients that are open and not the sender (if specified)
        if (client !== senderWs && client.readyState === WebSocket.OPEN) {
            try {
                client.send(messageString);
            } catch (error) {
                console.error("Error broadcasting message to a client:", error);
                // Optional: Terminate client connection if sending fails repeatedly
                // client.terminate();
            }
        }
    });
}

// Helper function to generate a simple unique ID
function generateUniqueId() {
    return Math.random().toString(36).substring(2, 15);
}

// Simple validation functions
function isValidPosition(pos) { return typeof pos === 'object' && typeof pos.x === 'number' && !isNaN(pos.x) && typeof pos.y === 'number' && !isNaN(pos.y) && typeof pos.z === 'number' && !isNaN(pos.z); }
function isValidRotation(rot) { return typeof rot === 'object' && typeof rot.pitch === 'number' && !isNaN(rot.pitch) && typeof rot.yaw === 'number' && !isNaN(rot.yaw); }

// --- END OF FILE server.js ---