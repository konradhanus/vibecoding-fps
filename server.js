// --- START OF FILE server.js ---

// server.js
const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 8080 });

let players = {}; // { id: { x, y, z, pitch, yaw, health, ammo, magazine, name, kills, deaths, lastUpdateTime, reloading, reloadStartTime } }
let projectiles = []; // { id, x, y, z, vx, vy, vz, ownerId, spawnTime }
let projectileIdCounter = 0;
let clientMap = new Map(); // Map<playerId, WebSocket>

const START_HEALTH = 100;
const START_AMMO = 100;
const START_MAGAZINE = 30; // Maksymalna pojemność magazynka
const RELOAD_DURATION = 2000; // ms - czas przeładowania
const PLAYER_RADIUS = 0.4;
const PLAYER_HEIGHT = 1.8;
const PROJECTILE_SPEED = 50;
const PROJECTILE_DAMAGE = 10;
const PROJECTILE_LIFETIME = 2000; // ms
const RESPAWN_TIME = 3000; // ms - Zmieniono na 3 sekundy
const INACTIVITY_TIMEOUT = 30000; // ms

console.log("Serwer WebSocket nasłuchuje na porcie 8080");

wss.on('connection', (ws) => {
    const playerId = generateUniqueId();
    const playerName = `Gracz_${playerId.substring(0, 4)}`;
    console.log(`Gracz ${playerName} (${playerId}) połączył się.`);

    // Inicjalizacja stanu gracza
    players[playerId] = {
        id: playerId,
        name: playerName,
        x: Math.random() * 10 - 5,
        y: 1,
        z: Math.random() * 10 - 5,
        pitch: 0,
        yaw: 0,
        health: START_HEALTH,
        ammo: START_AMMO,
        magazine: START_MAGAZINE,
        kills: 0,
        deaths: 0,
        reloading: false, // Dodano flagę przeładowania
        reloadStartTime: 0, // Dodano czas rozpoczęcia przeładowania
        lastUpdateTime: Date.now()
    };
    clientMap.set(playerId, ws);

    // Wyślij nowemu graczowi jego ID i aktualny stan gry
    ws.send(JSON.stringify({
        type: 'init',
        payload: {
            id: playerId,
            players: players,
            projectiles: projectiles.map(p => ({...p, type: 'projectile'}))
        }
    }));

    // Poinformuj innych o nowym graczu
    broadcast({
        type: 'player_joined',
        payload: { id: playerId, name: playerName, ...players[playerId] }
    }, ws);

    // Obsługa wiadomości od klienta
    ws.on('message', (message) => {
       try {
           const data = JSON.parse(message);
           const player = players[playerId];

           if (!player) {
               console.warn(`Otrzymano wiadomość od nieistniejącego gracza ${playerId}`);
               return;
           }

           player.lastUpdateTime = Date.now();

           // Obsługa wiadomości tylko od żywych graczy (poza specyficznymi akcjami)
           if (player.health <= 0 && !['request_respawn', 'chat_message'].includes(data.type)) {
                return;
           }

           switch (data.type) {
               case 'player_update':
                   if (isValidPosition(data.payload.position) && isValidRotation(data.payload.rotation)) {
                       player.x = data.payload.position.x;
                       player.y = 1.0;
                       player.z = data.payload.position.z;
                       player.pitch = data.payload.rotation.pitch;
                       player.yaw = data.payload.rotation.yaw;
                   }
                   break;
               case 'shoot':
                   // Strzelanie możliwe tylko gdy gracz żyje, nie przeładowuje i ma amunicję w magazynku
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
                       broadcast({ type: 'projectile_created', payload: {...newProjectile, type: 'projectile'} });
                       // Wyślij aktualizację amunicji tylko do strzelającego
                       ws.send(JSON.stringify({ type: 'ammo_update', payload: { magazine: player.magazine, ammo: player.ammo } }));
                   }
                   break;
                case 'request_reload':
                    // Rozpocznij przeładowanie jeśli gracz żyje, nie przeładowuje, magazynek nie jest pełny i ma amunicję zapasową
                    if (player.health > 0 && !player.reloading && player.magazine < START_MAGAZINE && player.ammo > 0) {
                        console.log(`Gracz ${player.name} rozpoczyna przeładowanie.`);
                        player.reloading = true;
                        player.reloadStartTime = Date.now();

                        // Zakończ przeładowanie po RELOAD_DURATION
                        setTimeout(() => {
                            // Sprawdź ponownie czy gracz istnieje i czy *nadal* przeładowuje (mógł zginąć/rozłączyć się)
                            const currentPlayer = players[playerId];
                            if (currentPlayer && currentPlayer.reloading) {
                                const ammoNeeded = START_MAGAZINE - currentPlayer.magazine;
                                const ammoToMove = Math.min(ammoNeeded, currentPlayer.ammo);

                                currentPlayer.magazine += ammoToMove;
                                currentPlayer.ammo -= ammoToMove;
                                currentPlayer.reloading = false;

                                console.log(`Gracz ${currentPlayer.name} zakończył przeładowanie. Amunicja: ${currentPlayer.magazine}/${currentPlayer.ammo}`);

                                // Wyślij aktualizację amunicji do klienta
                                const playerWs = clientMap.get(playerId);
                                if (playerWs && playerWs.readyState === WebSocket.OPEN) {
                                    playerWs.send(JSON.stringify({ type: 'ammo_update', payload: { magazine: currentPlayer.magazine, ammo: currentPlayer.ammo } }));
                                }
                            }
                        }, RELOAD_DURATION);

                        // Opcjonalnie: wyślij potwierdzenie rozpoczęcia przeładowania (jeśli klient tego potrzebuje)
                        // ws.send(JSON.stringify({ type: 'reload_started', payload: { duration: RELOAD_DURATION } }));
                    }
                    break;
           }
       } catch (error) {
           console.error(`Błąd przetwarzania wiadomości od ${playerName} (${playerId}):`, error, "Wiadomość:", message.toString());
       }
   });

    ws.on('close', () => {
        handleDisconnect(playerId, playerName, "rozłączył się");
    });

    ws.on('error', (error) => {
        console.error(`Błąd WebSocket dla gracza ${playerName} (${playerId}):`, error);
    });
});

// Główna pętla gry
let lastTickTime = Date.now();
setInterval(() => {
    const now = Date.now();
    const deltaTime = Math.min((now - lastTickTime) / 1000.0, 0.1);
    lastTickTime = now;

    const hitEvents = [];
    const expiredProjectiles = [];
    const deathEvents = [];

    // 1. Aktualizacja pocisków i detekcja kolizji
    projectiles = projectiles.filter(p => {
        p.x += p.vx * deltaTime;
        p.y += p.vy * deltaTime;
        p.z += p.vz * deltaTime;

        if (now - p.spawnTime > PROJECTILE_LIFETIME || p.y < -1) {
            expiredProjectiles.push(p.id);
            return false;
        }

        for (const targetId in players) {
            // Nie można trafić siebie ani graczy, którzy są martwi lub się przeładowują (opcjonalne - zazwyczaj można trafiać przeładowujących)
            if (p.ownerId === targetId) continue;
            const target = players[targetId];
            if (!target || target.health <= 0) continue; // Pomiń nieistniejących lub martwych

            const dx = p.x - target.x;
            const dy = p.y - (target.y + PLAYER_HEIGHT / 2);
            const dz = p.z - target.z;
            const distSq = dx * dx + dy * dy + dz * dz;
            const collisionThresholdSq = (PLAYER_RADIUS + 0.1) * (PLAYER_RADIUS + 0.1);

            if (distSq < collisionThresholdSq) {
                target.health -= PROJECTILE_DAMAGE;
                expiredProjectiles.push(p.id);

                const attacker = players[p.ownerId];
                const attackerName = attacker?.name || 'Nieznany';

                hitEvents.push({
                    targetId: targetId,
                    newHealth: target.health,
                    attackerId: p.ownerId,
                    attackerName: attackerName
                });

                console.log(`Gracz ${target.name} trafiony przez ${attackerName}. Zdrowie: ${target.health}`);

                if (target.health <= 0) {
                    target.health = 0;
                    target.deaths++;
                    target.reloading = false; // Przerwij przeładowanie przy śmierci
                    console.log(`Gracz ${target.name} pokonany przez ${attackerName}.`);

                    deathEvents.push({
                        victimId: targetId,
                        victimName: target.name,
                        attackerId: p.ownerId,
                        attackerName: attackerName
                    });

                    if (attacker && attacker.id !== targetId) {
                       attacker.kills++;
                    }

                    console.log(`Statystyki ${target.name}: ${target.kills} K / ${target.deaths} D`);
                    if (attacker) {
                        console.log(`Statystyki ${attacker.name}: ${attacker.kills} K / ${attacker.deaths} D`);
                    }

                    setTimeout(() => respawnPlayer(targetId), RESPAWN_TIME);
                }
                return false;
            }
        }
        return true;
    });

    // 2. Rozsyłanie stanu gry
    const gameState = {
        type: 'game_state',
        payload: {
            players: players, // Wysyłaj zawsze pełne dane graczy (w tym reloading)
            hits: hitEvents,
            deaths: deathEvents,
            removedProjectiles: expiredProjectiles
        }
    };
    broadcast(gameState);

    // 3. Usuwanie nieaktywnych graczy
    for (const playerId in players) {
        if (now - players[playerId].lastUpdateTime > INACTIVITY_TIMEOUT) {
            const wsInstance = clientMap.get(playerId);
            const playerName = players[playerId]?.name || playerId;
            if (wsInstance) {
                console.log(`Rozłączanie nieaktywnego gracza ${playerName}.`);
                wsInstance.close();
            } else {
                 handleDisconnect(playerId, playerName, "usunięty z powodu braku aktywności (brak WS)");
            }
        }
    }

}, 1000 / 30);

function respawnPlayer(playerId) {
    const player = players[playerId];
    if (player) {
        console.log(`Odradzanie gracza ${player.name}`);
        player.x = Math.random() * 10 - 5;
        player.y = 1;
        player.z = Math.random() * 10 - 5;
        player.health = START_HEALTH;
        player.magazine = START_MAGAZINE;
        player.ammo = START_AMMO;
        player.reloading = false; // Upewnij się, że nie jest w stanie przeładowania
        player.lastUpdateTime = Date.now();

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
        console.log(`Próba odrodzenia gracza ${playerId}, który już nie istnieje.`);
    }
}

function handleDisconnect(playerId, playerName, reason) {
    console.log(`Gracz ${playerName || playerId} ${reason}.`);
    const disconnectedPlayerName = players[playerId]?.name;
    if (players[playerId]) {
        delete players[playerId];
    }
    clientMap.delete(playerId);
    broadcast({
        type: 'player_left',
        payload: { id: playerId, name: disconnectedPlayerName || 'Nieznany' }
    });
}

function broadcast(message, senderWs = null) {
    const messageString = JSON.stringify(message);
    wss.clients.forEach((client) => {
        if (client !== senderWs && client.readyState === WebSocket.OPEN) {
            try {
                client.send(messageString);
            } catch (error) {
                console.error("Błąd podczas wysyłania broadcast do klienta:", error);
            }
        }
    });
}

function generateUniqueId() {
    return Math.random().toString(36).substring(2, 15);
}

function isValidPosition(pos) { return typeof pos==='object' && typeof pos.x==='number' && !isNaN(pos.x) && typeof pos.y==='number' && !isNaN(pos.y) && typeof pos.z==='number' && !isNaN(pos.z); }
function isValidRotation(rot) { return typeof rot==='object' && typeof rot.pitch==='number' && !isNaN(rot.pitch) && typeof rot.yaw==='number' && !isNaN(rot.yaw); }