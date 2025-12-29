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
        currentQuestion: -1,
        score: 0,
        answers: [],
        wasKicked: false,  // Flag pour empêcher reconnexion après kicked
        isPaused: false,  // État de pause
        lastResultsHash: null,  // Hash des derniers résultats pour éviter doublons
        lastDisplayedResultsQuestion: null  // Index de la dernière question dont les résultats ont été affichés
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
        SESSION_STATE.currentQuestion = -1;  // -1 = aucune question encore affichée
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
     * Connecter au système de polling (remplace le SSE)
     */
    function connectToEventStream() {
        console.log('🔵 Démarrage du polling élève');
        startPolling();
    }

    // Note: Le ping est maintenant géré par le polling via get_state

    /**
     * Gérer les événements de jeu (fonction gardée pour compatibilité mais plus utilisée avec polling)
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

    function showQuestion(questionData) {
        console.log('📩 ÉLÈVE: Reçu événement question', questionData);
        console.log('📩 Stack trace:', new Error().stack);
        
        // Mettre à jour totalQuestions si fourni
        if (questionData.totalQuestions) {
            if (!SESSION_STATE.quizData) {
                SESSION_STATE.quizData = {};
            }
            SESSION_STATE.quizData.totalQuestions = questionData.totalQuestions;
            console.log('📊 ÉLÈVE: Total questions mis à jour:', questionData.totalQuestions);
        }
        
        // Le format peut varier selon la source (SSE vs polling)
        // Format polling: {index, data, startTime}
        // Format attendu par displayQuestion: {index, question, startTime}
        
        let formattedData;
        
        if (questionData.data) {
            // Format polling: adapter la structure MAIS conserver startTime ET totalQuestions
            formattedData = {
                index: questionData.index,
                question: questionData.data,
                startTime: questionData.startTime, // IMPORTANT : conserver le timestamp du serveur
                totalQuestions: questionData.totalQuestions // IMPORTANT : transférer le total
            };
            console.log('🔄 ÉLÈVE: Format adapté de polling vers display (startTime et totalQuestions conservés)');
        } else {
            // Format déjà correct
            formattedData = questionData;
        }
        
        // Mettre à jour l'index de la question actuelle
        if (formattedData.index !== undefined) {
            console.log(`🔄 ÉLÈVE: Changement currentQuestion: ${SESSION_STATE.currentQuestion} -> ${formattedData.index}`);
            SESSION_STATE.currentQuestion = formattedData.index;
        }
        
        if (window.displayQuestion) {
            window.displayQuestion(formattedData);
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
    // POLLING (FALLBACK SI SSE NE FONCTIONNE PAS)
    // ========================================
    
    let pollingInterval = null;
    let lastStateHash = null;
    
    function startPolling() {
        console.log('🔄 Démarrage du mode polling (1 requête/seconde)');
        SESSION_STATE.usingPolling = true;
        
        // Arrêter le polling existant si présent
        if (pollingInterval) {
            clearInterval(pollingInterval);
        }
        
        // Fonction de polling
        const poll = async () => {
            if (!SESSION_STATE.playCode || !SESSION_STATE.playerNickname) {
                return;
            }
            
            try {
                const response = await fetch(`php/game.php?action=get_state&playCode=${SESSION_STATE.playCode}&nickname=${encodeURIComponent(SESSION_STATE.playerNickname)}`);
                const data = await response.json();
                
                if (!data.success) {
                    if (data.kicked) {
                        console.log('🚫 Joueur retiré de la partie');
                        SESSION_STATE.wasKicked = true;
                        if (pollingInterval) {
                            clearInterval(pollingInterval);
                        }
                        alert('Vous avez été retiré de la partie par le professeur.');
                        window.location.href = 'index.html';
                    }
                    return;
                }
                
                // Détecter les changements
                const stateHash = JSON.stringify({
                    state: data.state,
                    players: data.players.length,
                    currentQuestion: data.currentQuestion,
                    paused: data.paused
                });
                
                // Mise à jour des joueurs
                if (data.players) {
                    updatePlayersList(data.players);
                    
                    // Mettre à jour le score si on est sur la page de résultats
                    const resultsScreen = document.querySelector('.results-screen');
                    if (resultsScreen) {
                        const myData = data.players.find(p => p.nickname === SESSION_STATE.playerNickname);
                        if (myData) {
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
                }
                
                // Démarrage du jeu + première question
                if (data.state === 'playing') {
                    // Si on a une question à afficher
                    if (data.question) {
                        // Vérifier si c'est une nouvelle question (différente de celle actuellement affichée)
                        if (data.currentQuestion !== SESSION_STATE.currentQuestion) {
                            console.log('📩 Polling: Nouvelle question détectée', {
                                serveurQuestion: data.currentQuestion, 
                                clientQuestion: SESSION_STATE.currentQuestion,
                                timestamp: new Date().toISOString()
                            });
                            SESSION_STATE.currentQuestion = data.currentQuestion;
                            showQuestion(data.question);
                        } else {
                            console.log('⏭️ Polling: Question inchangée, pas de mise à jour');
                        }
                    } 
                    // Sinon, si c'est le premier passage en 'playing', afficher le compte à rebours
                    else if (!lastStateHash || !lastStateHash.includes('"state":"playing"')) {
                        console.log('🎮 Polling: Démarrage du jeu détecté (compte à rebours)');
                        startGame(data);
                    }
                }
                
                // Résultats disponibles
                if (data.results) {
                    const questionIndex = data.results.questionIndex;
                    
                    console.log('📊 Polling: Résultats détectés', {
                        questionIndex: questionIndex,
                        hasTop3: !!data.results.top3,
                        lastDisplayedQuestion: SESSION_STATE.lastDisplayedResultsQuestion
                    });
                    
                    // N'afficher les résultats qu'une seule fois par question
                    // (ignorer les mises à jour de score qui changeraient le hash)
                    if (SESSION_STATE.lastDisplayedResultsQuestion !== questionIndex) {
                        console.log('✅ Polling: Nouveaux résultats pour question', questionIndex);
                        SESSION_STATE.lastDisplayedResultsQuestion = questionIndex;
                        showResults(data.results);
                    } else {
                        console.log('⏭️ Polling: Résultats déjà affichés pour cette question');
                    }
                }
                
                // Pause
                if (data.paused !== SESSION_STATE.isPaused) {
                    SESSION_STATE.isPaused = data.paused;
                    if (window.handlePause) {
                        window.handlePause(data.paused);
                    }
                }
                
                // Fin du jeu
                if (data.state === 'finished') {
                    console.log('🏁 Polling: État finished détecté', {
                        hasFinalResults: !!data.finalResults,
                        finalResults: data.finalResults
                    });
                    
                    if (pollingInterval) {
                        clearInterval(pollingInterval);
                        console.log('🛑 Polling: Intervalle arrêté');
                    }
                    
                    // Envoyer les résultats finaux (même s'ils sont vides)
                    endGame(data.finalResults || {});
                }
                
                lastStateHash = stateHash;
                
            } catch (error) {
                console.error('❌ Erreur polling:', error);
            }
        };
        
        // Première requête immédiate
        poll();
        
        // Puis toutes les secondes
        pollingInterval = setInterval(poll, 1000);
    }

    // ========================================
    // DÉCONNEXION AUTOMATIQUE
    // ========================================
    
    // Marquer comme déconnecté quand on ferme l'onglet
    window.addEventListener('beforeunload', function() {
        if (SESSION_STATE.playCode && SESSION_STATE.playerNickname) {
            // Arrêter le polling
            if (pollingInterval) {
                clearInterval(pollingInterval);
            }
            
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
