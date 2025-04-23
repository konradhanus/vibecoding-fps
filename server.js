// server.js
const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 8080 });

let players = {}; // Przechowuje stan graczy { id: { x, y, z, pitch, yaw, health, ammo, magazine, name } }
let projectiles = []; // Przechowuje aktywne pociski { id, x, y, z, vx, vy, vz, ownerId }
let projectileIdCounter = 0;

const START_HEALTH = 100;
const START_AMMO = 100;
const START_MAGAZINE = 30;
const PLAYER_SPEED = 5; // Jednostki na sekundę
const PLAYER_RADIUS = 0.5; // Do detekcji kolizji
const PROJECTILE_SPEED = 50;
const PROJECTILE_DAMAGE = 10;
const PROJECTILE_LIFETIME = 2000; // ms

console.log("Serwer WebSocket nasłuchuje na porcie 8080");

wss.on('connection', (ws) => {
    const playerId = generateUniqueId();
    const playerName = `Gracz_${playerId.substring(0, 4)}`;
    console.log(`Gracz ${playerName} (${playerId}) połączył się.`);

    // Inicjalizacja stanu gracza
    players[playerId] = {
        id: playerId,
        name: playerName,
        x: Math.random() * 10 - 5, // Losowa pozycja startowa
        y: 1,                     // Lekko nad ziemią
        z: Math.random() * 10 - 5,
        pitch: 0, // Kąt patrzenia góra/dół
        yaw: 0,   // Kąt patrzenia lewo/prawo
        health: START_HEALTH,
        ammo: START_AMMO,
        magazine: START_MAGAZINE,
        lastUpdateTime: Date.now()
    };

    // Wyślij nowemu graczowi jego ID i aktualny stan gry
    ws.send(JSON.stringify({
        type: 'init',
        payload: {
            id: playerId,
            players: players,
            projectiles: projectiles.map(p => ({...p, type: 'projectile'})) // Wyślij też istniejące pociski
        }
    }));

    // Poinformuj innych graczy o nowym graczu
    broadcast({
        type: 'player_joined',
        payload: players[playerId]
    }, ws); // Wyślij do wszystkich oprócz nowego

    // Obsługa wiadomości od klienta
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const player = players[playerId];
            if (!player) return; // Gracz już się rozłączył?

            player.lastUpdateTime = Date.now(); // Aktualizuj czas ostatniej aktywności

            switch (data.type) {
                case 'player_update':
                    // Prosta walidacja (można dodać bardziej zaawansowaną)
                    if (isValidPosition(data.payload.position) && isValidRotation(data.payload.rotation)) {
                        player.x = data.payload.position.x;
                        player.y = data.payload.position.y;
                        player.z = data.payload.position.z;
                        player.pitch = data.payload.rotation.pitch;
                        player.yaw = data.payload.rotation.yaw;
                    }
                    break;

                case 'shoot':
                    if (player.magazine > 0 && player.health > 0) {
                        player.magazine--;

                        const projectileId = `proj_${projectileIdCounter++}`;
                        const direction = data.payload.direction; // Oczekujemy znormalizowanego wektora
                        const startPos = data.payload.startPos; // Oczekujemy pozycji startowej pocisku

                        const newProjectile = {
                            id: projectileId,
                            x: startPos.x,
                            y: startPos.y,
                            z: startPos.z,
                            vx: direction.x * PROJECTILE_SPEED,
                            vy: direction.y * PROJECTILE_SPEED,
                            vz: direction.z * PROJECTILE_SPEED,
                            ownerId: playerId,
                            spawnTime: Date.now()
                        };
                        projectiles.push(newProjectile);

                        // Poinformuj wszystkich o nowym pocisku
                        broadcast({
                            type: 'projectile_created',
                            payload: {...newProjectile, type: 'projectile'}
                        });

                         // Wyślij zaktualizowaną amunicję tylko do strzelającego gracza
                         ws.send(JSON.stringify({
                            type: 'ammo_update',
                            payload: { magazine: player.magazine, ammo: player.ammo }
                        }));
                    }
                    break;
                // TODO: Dodać obsługę przeładowania, zmiany broni itp.
            }
        } catch (error) {
            console.error(`Błąd przetwarzania wiadomości od ${playerName}:`, error);
        }
    });

    // Obsługa rozłączenia
    ws.on('close', () => {
        console.log(`Gracz ${playerName} (${playerId}) rozłączył się.`);
        const disconnectedPlayer = players[playerId];
        delete players[playerId];
        // Poinformuj innych graczy
        broadcast({
            type: 'player_left',
            payload: { id: playerId }
        });
    });

    ws.on('error', (error) => {
        console.error(`Błąd WebSocket dla ${playerName}:`, error);
        // Dodatkowo obsłuż zamknięcie połączenia
        if (players[playerId]) {
             console.log(`Gracz ${playerName} (${playerId}) rozłączył się z powodu błędu.`);
             const disconnectedPlayer = players[playerId];
             delete players[playerId];
             broadcast({
                 type: 'player_left',
                 payload: { id: playerId }
             });
        }
    });
});

// Główna pętla gry na serwerze
let lastTickTime = Date.now();
setInterval(() => {
    const now = Date.now();
    const deltaTime = (now - lastTickTime) / 1000.0; // Delta time w sekundach
    lastTickTime = now;

    // 1. Aktualizacja pocisków i detekcja kolizji
    const hitEvents = [];
    const expiredProjectiles = [];

    projectiles = projectiles.filter(p => {
        // Przesuń pocisk
        p.x += p.vx * deltaTime;
        p.y += p.vy * deltaTime;
        p.z += p.vz * deltaTime;

        // Sprawdź czas życia
        if (now - p.spawnTime > PROJECTILE_LIFETIME) {
            expiredProjectiles.push(p.id);
            return false; // Usuń pocisk
        }

        // Sprawdź kolizje z graczami
        for (const targetId in players) {
            if (p.ownerId === targetId) continue; // Nie strzelaj do siebie

            const target = players[targetId];
            if (target.health <= 0) continue; // Nie strzelaj do martwych

            // Prosta detekcja kolizji (odległość)
            const dx = p.x - target.x;
            // Zakładamy, że środek gracza jest na y=1, a pocisk może trafić w "ciało" (np. 0.5 do 1.5)
            const dy = p.y - (target.y); // target.y jest podstawą, środek wyżej
            const dz = p.z - target.z;
            const distSq = dx * dx + dy * dy + dz * dz;
            const collisionThreshold = (PLAYER_RADIUS + 0.1) * (PLAYER_RADIUS + 0.1); // 0.1 to promień pocisku

            if (distSq < collisionThreshold) {
                target.health -= PROJECTILE_DAMAGE;
                hitEvents.push({ targetId: targetId, newHealth: target.health, attackerId: p.ownerId });
                expiredProjectiles.push(p.id); // Pocisk znika po trafieniu

                console.log(`Gracz ${target.name} trafiony przez ${players[p.ownerId]?.name || '???'}. Zdrowie: ${target.health}`);

                if (target.health <= 0) {
                    target.health = 0; // Nie może być ujemne
                    console.log(`Gracz ${target.name} pokonany.`);
                    // TODO: Mechanizm respawnu?
                    // Na razie tylko informujemy o śmierci
                     hitEvents.push({ targetId: targetId, killed: true, attackerId: p.ownerId });

                     // Tymczasowy prosty respawn po 5 sekundach
                     setTimeout(() => respawnPlayer(targetId), 5000);
                }
                return false; // Pocisk trafiał, usuń go
            }
        }

        // Proste sprawdzenie granic mapy (np. y < 0)
        if (p.y < 0) {
             expiredProjectiles.push(p.id);
             return false;
        }

        return true; // Zachowaj pocisk w liście
    });

    // 2. Rozsyłanie stanu gry (optymalizacja: wysyłaj tylko zmiany)
    // Dla uproszczenia wysyłamy pełny stan graczy regularnie
    const gameState = {
        type: 'game_state',
        payload: {
            players: players,
            hits: hitEvents, // Informacje o trafieniach
            removedProjectiles: expiredProjectiles // ID pocisków do usunięcia
        }
    };
    broadcast(gameState);

    // 3. Usuwanie nieaktywnych graczy (timeout)
    const timeoutThreshold = 30000; // 30 sekund braku aktywności
     for (const playerId in players) {
        if (now - players[playerId].lastUpdateTime > timeoutThreshold) {
             console.log(`Gracz ${players[playerId].name} (${playerId}) rozłączony z powodu braku aktywności.`);
             const ws = findWebSocketByPlayerId(playerId); // Potrzebna funkcja pomocnicza lub inna struktura danych
             if (ws) ws.close(); // Zamknij połączenie jeśli je znajdziemy
             // Rozłączenie przez ws.on('close') posprząta gracza i powiadomi innych
        }
     }


}, 1000 / 30); // Aktualizacja stanu gry ~30 razy na sekundę

function respawnPlayer(playerId) {
    const player = players[playerId];
    if (player) { // Sprawdź, czy gracz nadal istnieje (mógł się rozłączyć)
        console.log(`Respawning player ${player.name}`);
        player.x = Math.random() * 10 - 5;
        player.y = 1;
        player.z = Math.random() * 10 - 5;
        player.health = START_HEALTH;
        player.magazine = START_MAGAZINE; // Pełny magazynek po respawnie
        player.ammo = START_AMMO; // Można uzupełnić też zapas
        // Poinformuj wszystkich o respawnie (w tym samego gracza)
        broadcast({
            type: 'player_respawned',
            payload: {
                id: playerId,
                x: player.x,
                y: player.y,
                z: player.z,
                health: player.health,
                magazine: player.magazine,
                ammo: player.ammo
            }
        });
    }
}


// Funkcja pomocnicza do rozsyłania wiadomości
function broadcast(message, senderWs = null) {
    const messageString = JSON.stringify(message);
    wss.clients.forEach((client) => {
        // Wyślij do wszystkich oprócz nadawcy (jeśli podano) LUB jeśli klient jest gotowy
        if (client !== senderWs && client.readyState === WebSocket.OPEN) {
            client.send(messageString);
        }
    });
}

// Funkcja pomocnicza do generowania ID
function generateUniqueId() {
    return Math.random().toString(36).substring(2, 15);
}

// Proste funkcje walidacyjne
function isValidPosition(pos) {
    return typeof pos === 'object' &&
           typeof pos.x === 'number' && !isNaN(pos.x) &&
           typeof pos.y === 'number' && !isNaN(pos.y) &&
           typeof pos.z === 'number' && !isNaN(pos.z);
}

function isValidRotation(rot) {
     return typeof rot === 'object' &&
            typeof rot.pitch === 'number' && !isNaN(rot.pitch) &&
            typeof rot.yaw === 'number' && !isNaN(rot.yaw);
}

// Funkcja do znajdowania WebSocketu (wymagałaby mapowania ID na WS przy połączeniu)
// W obecnej strukturze jest to trudne, lepiej przechowywać WS w `players` lub mieć osobną mapę `id -> ws`
// Na potrzeby timeoutu, można po prostu wywołać ws.close() jeśli mamy referencję,
// a jeśli nie, to usunięcie z `players` wystarczy, by inni przestali go widzieć.
let clientMap = new Map(); // Map<playerId, WebSocket>

wss.on('connection', (ws) => {
    // ... (reszta kodu w connection)
    clientMap.set(playerId, ws); // Zapisz mapowanie przy połączeniu

    ws.on('close', () => {
        // ... (reszta kodu w close)
        clientMap.delete(playerId); // Usuń mapowanie przy rozłączeniu
    });

     ws.on('error', (error) => {
        // ... (reszta kodu w error)
        clientMap.delete(playerId); // Usuń mapowanie przy błędzie
    });
});

function findWebSocketByPlayerId(playerId) {
    return clientMap.get(playerId);
}