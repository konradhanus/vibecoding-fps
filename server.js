// server.js
const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 8080 });

let players = {}; // { id: { x, y, z, pitch, yaw, health, ammo, magazine, name, kills, deaths, lastUpdateTime } }
let projectiles = []; // { id, x, y, z, vx, vy, vz, ownerId, spawnTime }
let projectileIdCounter = 0;
let clientMap = new Map(); // Map<playerId, WebSocket>

const START_HEALTH = 100;
const START_AMMO = 100;
const START_MAGAZINE = 30;
const PLAYER_RADIUS = 0.4; // Zmniejsz promień dla kolizji gracz-gracz
const PLAYER_HEIGHT = 1.8; // Wysokość gracza (dla kolizji)
const PROJECTILE_SPEED = 50;
const PROJECTILE_DAMAGE = 10;
const PROJECTILE_LIFETIME = 2000; // ms
const RESPAWN_TIME = 5000; // ms
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
        y: 1, // Pozycja "stóp" gracza lekko nad ziemią
        z: Math.random() * 10 - 5,
        pitch: 0,
        yaw: 0,
        health: START_HEALTH,
        ammo: START_AMMO,
        magazine: START_MAGAZINE,
        kills: 0, // Śledzenie zabójstw
        deaths: 0, // Śledzenie zgonów
        lastUpdateTime: Date.now()
    };
    clientMap.set(playerId, ws); // Zapisz mapowanie

    // Wyślij nowemu graczowi jego ID i aktualny stan gry
    ws.send(JSON.stringify({
        type: 'init',
        payload: {
            id: playerId,
            players: players, // Wyślij wszystkich graczy (w tym nowego ze statystykami)
            projectiles: projectiles.map(p => ({...p, type: 'projectile'}))
        }
    }));

    // Poinformuj innych o nowym graczu (z jego imieniem)
    broadcast({
        type: 'player_joined',
        // Wyślij pełne dane nowego gracza, w tym jego imię i pozycję startową
        payload: { id: playerId, name: playerName, ...players[playerId] }
    }, ws); // Wyślij do wszystkich oprócz nowego

    // Obsługa wiadomości od klienta
    ws.on('message', (message) => {
       try {
           const data = JSON.parse(message);
           const player = players[playerId];

           // Ignoruj wiadomości od graczy, którzy już nie istnieją
           if (!player) {
               console.warn(`Otrzymano wiadomość od nieistniejącego gracza ${playerId}`);
               return;
           }

           // Aktualizuj czas aktywności (nawet jeśli gracz jest martwy, aby zapobiec timeoutowi jeśli próbuje coś zrobić)
           player.lastUpdateTime = Date.now();

           // Obsługa wiadomości tylko od żywych graczy (poza specyficznymi akcjami jak np. czat)
           if (player.health <= 0 && !['request_respawn', 'chat_message'].includes(data.type)) { // Przykład z czatem
                return;
           }

           switch (data.type) {
               case 'player_update':
                   if (isValidPosition(data.payload.position) && isValidRotation(data.payload.rotation)) {
                       player.x = data.payload.position.x;
                       // Serwer decyduje o Y gracza, aby uprościć kolizje na kliencie
                       player.y = 1.0; // Utrzymuj graczy na poziomie gruntu serwera
                       player.z = data.payload.position.z;
                       player.pitch = data.payload.rotation.pitch;
                       player.yaw = data.payload.rotation.yaw;
                   }
                   break;
               case 'shoot':
                   if (player.magazine > 0) { // Sprawdź czy gracz ma amunicję (już w ifie głównym sprawdzamy czy żyje)
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
                       // Poinformuj wszystkich o nowym pocisku
                       broadcast({ type: 'projectile_created', payload: {...newProjectile, type: 'projectile'} });
                       // Wyślij aktualizację amunicji tylko do strzelającego
                       ws.send(JSON.stringify({ type: 'ammo_update', payload: { magazine: player.magazine, ammo: player.ammo } }));
                   }
                   break;
                // Można dodać inne typy wiadomości, np. 'reload', 'change_weapon', 'chat_message'
           }
       } catch (error) {
           // Loguj błąd razem z otrzymaną wiadomością dla lepszej diagnostyki
           console.error(`Błąd przetwarzania wiadomości od ${playerName} (${playerId}):`, error, "Wiadomość:", message.toString());
       }
   });

    // Obsługa rozłączenia
    ws.on('close', () => {
        handleDisconnect(playerId, playerName, "rozłączył się");
    });

    // Obsługa błędu
    ws.on('error', (error) => {
        console.error(`Błąd WebSocket dla gracza ${playerName} (${playerId}):`, error);
        // handleDisconnect jest wywoływane również w przypadku błędu, bo 'close' zazwyczaj następuje po 'error'
        // ale można dodać logikę specyficzną dla błędu, jeśli jest potrzebna
    });
});

// Główna pętla gry
let lastTickTime = Date.now();
setInterval(() => {
    const now = Date.now();
    // Ogranicz deltaTime, aby uniknąć problemów przy dużych lagach lub pauzach
    const deltaTime = Math.min((now - lastTickTime) / 1000.0, 0.1);
    lastTickTime = now;

    const hitEvents = [];
    const expiredProjectiles = [];
    const deathEvents = [];

    // 1. Aktualizacja pocisków i detekcja kolizji
    projectiles = projectiles.filter(p => {
        // Przesuń pocisk
        p.x += p.vx * deltaTime;
        p.y += p.vy * deltaTime;
        p.z += p.vz * deltaTime;

        // Sprawdź czas życia lub wyjście poza mapę (proste Y<0)
        if (now - p.spawnTime > PROJECTILE_LIFETIME || p.y < -1) { // Trochę niżej niż 0
            expiredProjectiles.push(p.id);
            return false; // Usuń pocisk
        }

        // Sprawdź kolizje z graczami
        for (const targetId in players) {
            if (p.ownerId === targetId) continue; // Nie strzelaj do siebie
            const target = players[targetId];
            if (!target || target.health <= 0) continue; // Pomiń nieistniejących lub martwych

            // Prosta kolizja - odległość od środka postaci
            const dx = p.x - target.x;
            const dy = p.y - (target.y + PLAYER_HEIGHT / 2); // Środek wysokości gracza (Y=1 to stopy)
            const dz = p.z - target.z;
            const distSq = dx * dx + dy * dy + dz * dz;
            // Kwadrat progu kolizji (promień gracza + promień pocisku)
            const collisionThresholdSq = (PLAYER_RADIUS + 0.1) * (PLAYER_RADIUS + 0.1); // 0.1 to promień pocisku

            if (distSq < collisionThresholdSq) {
                // Trafienie!
                target.health -= PROJECTILE_DAMAGE;
                expiredProjectiles.push(p.id); // Pocisk znika po trafieniu

                const attacker = players[p.ownerId]; // Pobierz atakującego
                const attackerName = attacker?.name || 'Nieznany'; // Uzyskaj imię atakującego

                // Dodaj zdarzenie trafienia (z imieniem atakującego)
                hitEvents.push({
                    targetId: targetId,
                    newHealth: target.health,
                    attackerId: p.ownerId,
                    attackerName: attackerName
                });

                console.log(`Gracz ${target.name} trafiony przez ${attackerName}. Zdrowie: ${target.health}`);

                // Sprawdź, czy gracz zginął
                if (target.health <= 0) {
                    target.health = 0; // Nie pozwól na ujemne zdrowie
                    target.deaths++; // Zwiększ liczbę śmierci ofiary
                    console.log(`Gracz ${target.name} pokonany przez ${attackerName}.`);

                    // Dodaj zdarzenie śmierci (z imionami)
                    deathEvents.push({
                        victimId: targetId,
                        victimName: target.name,
                        attackerId: p.ownerId,
                        attackerName: attackerName
                    });

                    // Zwiększ liczbę zabójstw atakującego (jeśli istnieje i nie zabił sam siebie)
                    if (attacker && attacker.id !== targetId) {
                       attacker.kills++;
                    }

                    // Loguj statystyki po śmierci
                    console.log(`Statystyki ${target.name}: ${target.kills} K / ${target.deaths} D`);
                    if (attacker) {
                        console.log(`Statystyki ${attacker.name}: ${attacker.kills} K / ${attacker.deaths} D`);
                    }

                    // Uruchom respawn dla ofiary
                    setTimeout(() => respawnPlayer(targetId), RESPAWN_TIME);
                }
                return false; // Pocisk trafiał, usuń go z listy do dalszego przetwarzania
            }
        }
        return true; // Zachowaj pocisk w liście, jeśli nie trafił lub nie wygasł
    });

    // 2. Rozsyłanie stanu gry
    const gameState = {
        type: 'game_state',
        payload: {
            players: players, // Wysyłaj zawsze pełne dane graczy (w tym K/D)
            hits: hitEvents,
            deaths: deathEvents, // Wyślij informacje o zgonach z imionami
            removedProjectiles: expiredProjectiles // ID pocisków do usunięcia na kliencie
        }
    };
    broadcast(gameState);

    // 3. Usuwanie nieaktywnych graczy
    for (const playerId in players) {
        if (now - players[playerId].lastUpdateTime > INACTIVITY_TIMEOUT) {
            const wsInstance = clientMap.get(playerId);
            const playerName = players[playerId]?.name || playerId; // Użyj imienia jeśli dostępne
            if (wsInstance) {
                console.log(`Rozłączanie nieaktywnego gracza ${playerName}.`);
                wsInstance.close(); // Zamknięcie WS wywoła 'close' i sprzątanie w handleDisconnect
            } else {
                 // Rzadki przypadek: gracz jest w liście, ale nie ma go w mapie WS
                 handleDisconnect(playerId, playerName, "usunięty z powodu braku aktywności (brak WS)");
            }
        }
    }

}, 1000 / 30); // Aktualizacja stanu gry ~30 razy na sekundę

function respawnPlayer(playerId) {
    const player = players[playerId];
    if (player) { // Sprawdź, czy gracz nadal istnieje (mógł się rozłączyć w międzyczasie)
        console.log(`Odradzanie gracza ${player.name}`);
        // Ustaw nowe losowe pozycje i zresetuj stan
        player.x = Math.random() * 10 - 5;
        player.y = 1; // Pozycja stóp
        player.z = Math.random() * 10 - 5;
        player.health = START_HEALTH;
        player.magazine = START_MAGAZINE;
        player.ammo = START_AMMO;
        // Kills i deaths NIE są resetowane przy respawnie
        player.lastUpdateTime = Date.now(); // Zaktualizuj czas aktywności przy respawnie

        // Poinformuj wszystkich o respawnie (w tym samego gracza)
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
    const disconnectedPlayerName = players[playerId]?.name; // Pobierz imię przed usunięciem gracza
    if (players[playerId]) {
        delete players[playerId]; // Usuń gracza z głównej listy stanu
    }
    clientMap.delete(playerId); // Usuń mapowanie WebSocketu
    // Poinformuj pozostałych graczy o wyjściu (wyślij imię)
    broadcast({
        type: 'player_left',
        payload: { id: playerId, name: disconnectedPlayerName || 'Nieznany' } // Użyj zapisanego imienia
    });
}

// Funkcja pomocnicza do rozsyłania wiadomości
function broadcast(message, senderWs = null) {
    const messageString = JSON.stringify(message);
    // Iteruj po wszystkich połączonych klientach
    wss.clients.forEach((client) => {
        // Wyślij do wszystkich oprócz nadawcy (jeśli podano) LUB jeśli klient jest gotowy do odbioru
        if (client !== senderWs && client.readyState === WebSocket.OPEN) {
            try {
                client.send(messageString);
            } catch (error) {
                // Loguj błąd, ale nie przerywaj pętli dla innych klientów
                console.error("Błąd podczas wysyłania broadcast do klienta:", error);
                // Można by dodać logikę rozłączania klienta, który powoduje błąd przy wysyłaniu
                // client.terminate();
            }
        }
    });
}

// Funkcja pomocnicza do generowania unikalnego ID
function generateUniqueId() {
    // Prosty generator ID - w produkcji warto użyć czegoś bardziej niezawodnego (np. uuid)
    return Math.random().toString(36).substring(2, 15);
}

// Proste funkcje walidacyjne (bez zmian)
function isValidPosition(pos) { return typeof pos==='object' && typeof pos.x==='number' && !isNaN(pos.x) && typeof pos.y==='number' && !isNaN(pos.y) && typeof pos.z==='number' && !isNaN(pos.z); }
function isValidRotation(rot) { return typeof rot==='object' && typeof rot.pitch==='number' && !isNaN(rot.pitch) && typeof rot.yaw==='number' && !isNaN(rot.yaw); }