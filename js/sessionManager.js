// ============================================
// MODULE: SESSION MANAGER
// Description: Gestion des sessions de jeu en temps réel
// ============================================

(function() {
    'use strict';

    // État de la session actuelle
    const SESSION_STATE = {
        sessionId: null,
        playCode: null,
        quizData: null,
        schoolName: '',
        playerNickname: '',
        playerAnimal: '',
        isHost: false,
        gameState: 'waiting', // waiting, playing, finished
        currentQuestion: 0,
        score: 0,
        answers: [],
        eventSource: null,
        reconnectAttempts: 0,
        lastPing: Date.now(),
        wasKicked: false  // Flag pour empêcher reconnexion après kicked
    };

    // Liste des collèges (exemples)
    const SCHOOLS = [
        'Collège Jean Moulin',
        'Collège Victor Hugo',
        'Collège Marie Curie',
        'Collège Jules Verne',
        'Collège Jean de La Fontaine',
        'Collège Molière',
        'Collège Voltaire',
        'Collège Rousseau',
        'Collège Albert Camus',
        'Collège Simone de Beauvoir',
        'Collège George Sand',
        'Collège Jacques Prévert',
        'Collège Paul Éluard',
        'Collège Arthur Rimbaud',
        'Collège Charles Baudelaire',
        'Collège Émile Zola',
        'Collège Honoré de Balzac',
        'Collège Gustave Flaubert',
        'Collège Stendhal',
        'Collège Alexandre Dumas',
        'Autre (saisir le nom)'
    ];

    /**
     * Initialiser une session élève
     */
    function initStudentSession(playCode, quizData) {
        SESSION_STATE.playCode = playCode;
        SESSION_STATE.quizData = quizData;
        SESSION_STATE.sessionId = playCode;
        SESSION_STATE.isHost = false;
        SESSION_STATE.gameState = 'waiting';
        SESSION_STATE.currentQuestion = 0;
        SESSION_STATE.score = 0;
        SESSION_STATE.answers = [];
    }

    /**
     * Définir les informations du joueur
     */
    function setPlayerInfo(schoolName, animal) {
        SESSION_STATE.schoolName = '';
        SESSION_STATE.playerAnimal = animal;
        SESSION_STATE.playerNickname = animal;
    }

    /**
     * Rejoindre une session
     */
    async function joinSession() {
        console.log('🔵 Tentative de rejoindre la session:', {
            playCode: SESSION_STATE.playCode,
            nickname: SESSION_STATE.playerNickname
        });
        
        try {
            const response = await fetch('php/game.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    action: 'join',
                    playCode: SESSION_STATE.playCode,
                    nickname: SESSION_STATE.playerNickname
                })
            });

            const result = await response.json();
            console.log('🔵 Réponse joinSession:', result);

            if (result.success) {
                // Connecter au flux SSE
                connectToEventStream();
                return true;
            } else {
                console.error('❌ Échec joinSession:', result.message);
                alert('❌ Impossible de rejoindre : ' + (result.message || 'Erreur inconnue'));
                return false;
            }

        } catch (error) {
            console.error('❌ Erreur lors de la connexion:', error);
            alert('❌ Erreur de connexion au serveur');
            return false;
        }
    }

    /**
     * Connecter au flux d'événements serveur (SSE)
     */
    function connectToEventStream() {
        const url = `php/game.php?action=stream&playCode=${SESSION_STATE.playCode}&nickname=${encodeURIComponent(SESSION_STATE.playerNickname)}`;
        
        console.log('🔵 Connexion SSE vers:', url);
        SESSION_STATE.eventSource = new EventSource(url);

        SESSION_STATE.eventSource.addEventListener('connected', function(event) {
            console.log('✅ SSE connecté:', event.data);
            SESSION_STATE.reconnectAttempts = 0;
        });

        SESSION_STATE.eventSource.addEventListener('error', function(event) {
            // Ne pas logger les erreurs de reconnexion normales
            if (SESSION_STATE.eventSource.readyState === EventSource.CONNECTING) {
                // Reconnexion en cours, c'est normal
                return;
            }
            if (SESSION_STATE.eventSource.readyState === EventSource.CLOSED) {
                // Fermé par le serveur (timeout), reconnexion auto
                console.log('🔄 SSE fermé par timeout serveur, reconnexion...');
                return;
            }
            // Seulement logger les vraies erreurs
            console.warn('⚠️ SSE: Problème de connexion', event);
        });

        SESSION_STATE.eventSource.onmessage = function(event) {
            try {
                const data = JSON.parse(event.data);
                handleGameEvent(data);
            } catch (error) {
                console.error('Erreur parsing événement:', error);
            }
        };

        SESSION_STATE.eventSource.onerror = function(error) {
            // ReadyState: 0 = CONNECTING, 1 = OPEN, 2 = CLOSED
            const state = SESSION_STATE.eventSource.readyState;
            
            if (state === EventSource.CONNECTING) {
                // Reconnexion en cours, c'est normal
                return;
            }
            
            if (state === EventSource.CLOSED) {
                // Ne pas reconnecter si le joueur a été kicked
                if (SESSION_STATE.wasKicked) {
                    console.log('🚫 Pas de reconnexion : joueur supprimé');
                    return;
                }
                
                // Connexion fermée, tenter de reconnecter
                if (SESSION_STATE.reconnectAttempts < 5) {
                    SESSION_STATE.reconnectAttempts++;
                    console.log(`🔄 Tentative de reconnexion ${SESSION_STATE.reconnectAttempts}/5`);
                    setTimeout(() => {
                        connectToEventStream();
                    }, 2000 * SESSION_STATE.reconnectAttempts);
                } else {
                    console.error('❌ Échec reconnexion après 5 tentatives');
                }
            }
        };

        SESSION_STATE.eventSource.addEventListener('players', function(event) {
            const data = JSON.parse(event.data);
            updatePlayersList(data.players);
            
            // Mettre à jour le score si on est sur la page de résultats
            const resultsScreen = document.querySelector('.results-screen');
            if (resultsScreen) {
                const myData = data.players.find(p => p.nickname === SESSION_STATE.playerNickname);
                if (myData) {
                    console.log('🔄 Mise à jour score temps réel:', myData.score);
                    
                    // Mettre à jour le score affiché
                    const scoreElement = document.querySelector('.score-value');
                    if (scoreElement) {
                        scoreElement.textContent = `${myData.score || 0} pts`;
                    }
                    
                    // Recalculer la position
                    const sortedPlayers = [...data.players].sort((a, b) => (b.score || 0) - (a.score || 0));
                    const myPosition = sortedPlayers.findIndex(p => p.nickname === SESSION_STATE.playerNickname) + 1;
                    const positionElement = document.querySelector('.position-value');
                    if (positionElement) {
                        positionElement.textContent = `#${myPosition}`;
                    }
                }
            }
        });

        SESSION_STATE.eventSource.addEventListener('start', function(event) {
            const data = JSON.parse(event.data);
            startGame(data);
        });

        SESSION_STATE.eventSource.addEventListener('question', function(event) {
            const data = JSON.parse(event.data);
            console.log('🎯 ÉLÈVE: Nouvelle question reçue (index:', data.index, ')');
            
            // Si on reçoit une nouvelle question, on affiche immédiatement
            // Même si on était sur la page de résultats
            showQuestion(data);
        });

        SESSION_STATE.eventSource.addEventListener('results', function(event) {
            const data = JSON.parse(event.data);
            showResults(data);
        });

        SESSION_STATE.eventSource.addEventListener('end', function(event) {
            const data = JSON.parse(event.data);
            endGame(data);
        });

        SESSION_STATE.eventSource.addEventListener('pause', function(event) {
            const data = JSON.parse(event.data);
            console.log('⏸️ ÉLÈVE: Pause', data.paused ? 'activée' : 'désactivée');
            if (window.handlePause) {
                window.handlePause(data.paused);
            }
        });
        
        SESSION_STATE.eventSource.addEventListener('kicked', function(event) {
            const data = JSON.parse(event.data);
            console.log('🚫 ÉLÈVE: Retiré de la partie');
            
            // Marquer comme kicked pour empêcher reconnexion
            SESSION_STATE.wasKicked = true;
            
            // Fermer le SSE pour éviter la reconnexion
            if (SESSION_STATE.eventSource) {
                SESSION_STATE.eventSource.close();
                SESSION_STATE.eventSource = null;
            }
            
            // Alerter et rediriger
            alert('Vous avez été retiré de la partie par le professeur.');
            window.location.href = 'index.html';
        });

        // Ping régulier pour maintenir la connexion
        setInterval(() => {
            sendPing();
        }, CONFIG.PING_INTERVAL);
    }

    /**
     * Gérer les événements de jeu
     */
    function handleGameEvent(data) {
        SESSION_STATE.lastPing = Date.now();

        switch(data.type) {
            case 'players_update':
                updatePlayersList(data.players);
                break;
            case 'game_start':
                startGame(data);
                break;
            case 'show_question':
                showQuestion(data);
                break;
            case 'show_results':
                showResults(data);
                break;
            case 'game_end':
                endGame(data);
                break;
        }
    }

    /**
     * Envoyer un ping au serveur
     */
    async function sendPing() {
        if (!SESSION_STATE.playCode || !SESSION_STATE.playerNickname) return;

        try {
            await fetch('php/game.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    action: 'ping',
                    playCode: SESSION_STATE.playCode,
                    nickname: SESSION_STATE.playerNickname
                })
            });
        } catch (error) {
            console.error('Erreur ping:', error);
        }
    }

    /**
     * Envoyer une réponse
     */
    async function submitAnswer(answer, timeSpent) {
        console.log('📤 ÉLÈVE: Envoi réponse', { answer, timeSpent, questionIndex: SESSION_STATE.currentQuestion });
        try {
            const response = await fetch('php/game.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    action: 'answer',
                    playCode: SESSION_STATE.playCode,
                    nickname: SESSION_STATE.playerNickname,
                    questionIndex: SESSION_STATE.currentQuestion,
                    answer: JSON.stringify(answer),
                    timeSpent: timeSpent
                })
            });

            const result = await response.json();
            console.log('✅ ÉLÈVE: Réponse envoyée, résultat:', result);
            return result.success;

        } catch (error) {
            console.error('❌ ÉLÈVE: Erreur envoi réponse:', error);
            return false;
        }
    }

    /**
     * Quitter la session
     */
    function leaveSession() {
        if (SESSION_STATE.eventSource) {
            SESSION_STATE.eventSource.close();
        }

        // Notifier le serveur
        if (SESSION_STATE.playCode && SESSION_STATE.playerNickname) {
            fetch('php/game.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    action: 'leave',
                    playCode: SESSION_STATE.playCode,
                    nickname: SESSION_STATE.playerNickname
                })
            });
        }

        // Réinitialiser l'état
        SESSION_STATE.sessionId = null;
        SESSION_STATE.playCode = null;
        SESSION_STATE.eventSource = null;
    }

    /**
     * Obtenir la liste des collèges
     */
    function getSchools() {
        return SCHOOLS;
    }

    /**
     * Obtenir l'état actuel de la session
     */
    function getSessionState() {
        return { ...SESSION_STATE };
    }

    // ========================================
    // FONCTIONS APPELÉES PAR LES ÉVÉNEMENTS
    // ========================================
    // Ces fonctions seront implémentées dans game.js

    function updatePlayersList(players) {
        if (window.updateWaitingRoom) {
            window.updateWaitingRoom(players);
        }
    }

    function startGame(data) {
        if (window.handleGameStart) {
            window.handleGameStart(data);
        }
    }

    function showQuestion(data) {
        console.log('📩 ÉLÈVE: Reçu événement question', data);
        
        // Mettre à jour l'index de la question actuelle
        if (data.index !== undefined) {
            SESSION_STATE.currentQuestion = data.index;
            console.log('🔄 ÉLÈVE: currentQuestion mis à jour:', SESSION_STATE.currentQuestion);
        }
        
        if (window.displayQuestion) {
            window.displayQuestion(data);
        } else {
            console.error('❌ displayQuestion non défini !');
        }
    }

    function showResults(data) {
        if (window.displayQuestionResults) {
            window.displayQuestionResults(data);
        }
    }

    function endGame(data) {
        // Fermer le SSE pour arrêter tout flux d'événements
        if (SESSION_STATE.eventSource) {
            console.log('🔴 ÉLÈVE: Fermeture SSE (partie terminée)');
            SESSION_STATE.eventSource.close();
            SESSION_STATE.eventSource = null;
        }
        
        // Retirer l'overlay de pause si présent
        const pauseOverlay = document.getElementById('pause-overlay');
        if (pauseOverlay) {
            pauseOverlay.remove();
        }
        
        // Log des données reçues pour debug
        console.log('🔍 ÉLÈVE: Données endGame:', data);
        
        // Le serveur nous dit explicitement si la partie a commencé
        const gameStarted = data?.gameStarted === true;
        const hasPlayers = (data?.players || []).length > 0;
        
        console.log('🔍 ÉLÈVE: gameStarted =', gameStarted, ', hasPlayers =', hasPlayers);
        
        // Si la partie n'a pas commencé (salle d'attente), retourner à l'accueil
        if (!gameStarted || !hasPlayers) {
            console.log('🏠 ÉLÈVE: Partie annulée, retour à l\'accueil');
            
            // Nettoyer l'état
            SESSION_STATE.playCode = null;
            SESSION_STATE.playerNickname = null;
            
            // Retourner à la page d'accueil
            if (window.showPage) {
                window.showPage('home-page');
            }
            return;
        }
        
        // Sinon, afficher les résultats finaux
        console.log('🏁 ÉLÈVE: Affichage résultats finaux', data);
        if (window.displayFinalResults) {
            window.displayFinalResults(data);
        }
    }

    // ========================================
    // DÉCONNEXION AUTOMATIQUE
    // ========================================
    
    // Marquer comme déconnecté quand on ferme l'onglet
    window.addEventListener('beforeunload', function() {
        if (SESSION_STATE.playCode && SESSION_STATE.playerNickname) {
            // Envoi synchrone pour garantir l'exécution
            const data = new URLSearchParams({
                action: 'leave',
                playCode: SESSION_STATE.playCode,
                nickname: SESSION_STATE.playerNickname
            });
            
            // Utiliser sendBeacon pour envoi garanti
            navigator.sendBeacon('php/game.php', data);
        }
    });

    // ========================================
    // EXPORT VERS GLOBAL
    // ========================================
    
    window.SESSION_STATE = SESSION_STATE;
    window.initStudentSession = initStudentSession;
    window.setPlayerInfo = setPlayerInfo;
    window.joinSession = joinSession;
    window.submitAnswer = submitAnswer;
    window.leaveSession = leaveSession;
    window.getSchools = getSchools;
    window.getSessionState = getSessionState;

})();
