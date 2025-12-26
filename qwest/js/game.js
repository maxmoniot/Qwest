// ============================================
// MODULE: PARTIE (GAME)
// Description: Gestion complète de la partie élève
// ============================================

(function() {
    'use strict';

    // Variables de jeu
    let currentQuestionData = null;
    let questionStartTime = null;
    let hasAnswered = false;
    let answerTimeout = null;

    // ========================================
    // PAGE DE SÉLECTION (Collège + Animal)
    // ========================================
    
    async function showStudentJoinPage(playCode, quizName, totalQuestions = 0) {
        const gameContainer = document.querySelector('.game-container');
        
        // Initialiser la session élève avec le playCode et totalQuestions
        initStudentSession(playCode, { name: quizName, totalQuestions: totalQuestions });
        
        // Obtenir 3 animaux UNIQUES depuis le serveur
        let animals = [];
        try {
            const response = await fetch(`php/api.php?action=get_animals&code=${playCode}`);
            const result = await response.json();
            if (result.success) {
                animals = result.animals;
            } else {
                console.error('❌ Impossible d\'obtenir les animaux');
                animals = ['🐕 Chien', '🐈 Chat', '🐰 Lapin']; // Fallback
            }
        } catch (error) {
            console.error('❌ Erreur API animaux:', error);
            animals = ['🐕 Chien', '🐈 Chat', '🐰 Lapin']; // Fallback
        }
        
        let html = `
            <div class="join-page">
                <div class="join-header">
                    <h2>📝 ${quizName}</h2>
                    <p class="join-subtitle">Choisis ton avatar</p>
                </div>
                
                <div class="join-form">
                    <div class="form-group">
                        <label>🎭 Choisis ton avatar :</label>
                        <div class="animal-grid">
        `;
        
        animals.forEach((animal, index) => {
            html += `
                <button class="animal-btn" data-animal="${animal}" onclick="selectAnimal('${animal}')">
                    <span class="animal-emoji">${animal.split(' ')[0]}</span>
                    <span class="animal-name">${animal.split(' ')[1]}</span>
                </button>
            `;
        });
        
        html += `
                        </div>
                        <p class="animal-info">Ton pseudo sera ton animal 🦁</p>
                    </div>
                    
                    <button id="join-game-btn" class="btn-join-game" onclick="confirmJoinGame()" disabled>
                        🚀 Rejoindre la partie
                    </button>
                </div>
            </div>
        `;
        
        gameContainer.innerHTML = html;
        showPage('game-page');
    }

    let selectedAnimal = null;

    function selectAnimal(animal) {
        selectedAnimal = animal;
        
        // Retirer la sélection précédente
        document.querySelectorAll('.animal-btn').forEach(btn => {
            btn.classList.remove('selected');
        });
        
        // Ajouter la sélection
        event.target.closest('.animal-btn').classList.add('selected');
        
        checkJoinButtonState();
    }

    function checkJoinButtonState() {
        const joinBtn = document.getElementById('join-game-btn');
        joinBtn.disabled = selectedAnimal === null;
    }

    async function confirmJoinGame() {
        if (!selectedAnimal) {
            alert('⚠️ Sélectionne un avatar');
            return;
        }
        
        // Enregistrer les infos (sans collège)
        setPlayerInfo('', selectedAnimal);
        
        // Rejoindre la session
        const success = await joinSession();
        
        if (success) {
            showWaitingRoom();
        } else {
            alert('❌ Impossible de rejoindre la partie');
        }
    }

    // ========================================
    // SALLE D'ATTENTE
    // ========================================
    
    function showWaitingRoom() {
        const gameContainer = document.querySelector('.game-container');
        
        gameContainer.innerHTML = `
            <div class="waiting-room">
                <div class="waiting-header">
                    <h2>⏳ En attente du démarrage...</h2>
                    <p class="waiting-subtitle">Le professeur va bientôt lancer la partie</p>
                </div>
                
                <div class="game-rules">
                    <p>⚡ Plus tu réponds correctement et rapidement, plus tu gagnes des points !</p>
                </div>
                
                <div class="players-container">
                    <h3>🎭 Joueurs connectés : <span id="player-count">0</span></h3>
                    <div id="players-list" class="players-grid">
                        <!-- Les joueurs apparaîtront ici -->
                    </div>
                </div>
                
                <div class="waiting-footer">
                    <p>✨ Ta connexion est active</p>
                    <div class="connection-pulse"></div>
                </div>
            </div>
        `;
    }

    function updateWaitingRoom(players) {
        const playersList = document.getElementById('players-list');
        const playerCount = document.getElementById('player-count');
        
        if (!playersList || !playerCount) return;
        
        playerCount.textContent = players.length;
        
        let html = '';
        players.forEach(player => {
            const isMe = player.nickname === SESSION_STATE.playerNickname;
            html += `
                <div class="player-card ${isMe ? 'is-me' : ''}">
                    <div class="player-avatar">${player.nickname.split(' ')[0]}</div>
                    <div class="player-name">${player.nickname.split(' ')[1]}</div>
                    ${isMe ? '<div class="player-badge">Toi</div>' : ''}
                </div>
            `;
        });
        
        playersList.innerHTML = html;
    }

    // ========================================
    // DÉMARRAGE DE LA PARTIE
    // ========================================
    
    function handleGameStart(data) {
        const gameContainer = document.querySelector('.game-container');
        
        // Animation de compte à rebours
        gameContainer.innerHTML = `
            <div class="countdown-screen">
                <h2>🎮 La partie commence !</h2>
                <div class="countdown-number" id="countdown">3</div>
            </div>
        `;
        
        let count = 3;
        const countdownEl = document.getElementById('countdown');
        
        const interval = setInterval(() => {
            count--;
            if (count > 0) {
                countdownEl.textContent = count;
                countdownEl.style.animation = 'none';
                setTimeout(() => {
                    countdownEl.style.animation = 'pulse 1s ease';
                }, 10);
            } else {
                clearInterval(interval);
                countdownEl.textContent = 'GO ! 🚀';
                setTimeout(() => {
                    // La première question sera affichée par l'événement SSE
                }, 1000);
            }
        }, 1000);
    }

    // ========================================
    // AFFICHAGE D'UNE QUESTION
    // ========================================
    
    function displayQuestion(data) {
        console.log('🎯 ÉLÈVE: Affichage question', data);
        
        currentQuestionData = data;
        questionStartTime = Date.now();
        hasAnswered = false;
        
        const gameContainer = document.querySelector('.game-container');
        const question = data.question;
        const questionNumber = data.index + 1;
        const totalQuestions = APP_STATE.questions?.length || 1;
        
        let html = `
            <div class="question-screen">
                <div class="question-header">
                    <div class="player-nickname-display">
                        ${SESSION_STATE.playerNickname}
                    </div>
                    <div class="question-progress">
                        Question ${questionNumber} / ${totalQuestions}
                    </div>
                    <div class="question-timer">
                        <div class="timer-bar" id="timer-bar"></div>
                        <span id="timer-text">${question.time}s</span>
                    </div>
                </div>
                
                <div class="question-content">
                    ${question.imageUrl ? `
                        <div class="question-image">
                            <img src="${question.imageUrl}" alt="Image de la question">
                        </div>
                    ` : ''}
                    <h2 class="question-text">${question.question}</h2>
                </div>
                
                <div class="answers-container" id="answers-container">
        `;
        
        // Générer les réponses selon le type
        switch(question.type) {
            case 'multiple':
            case 'truefalse':
                // Mélanger les réponses avec leurs index d'origine
                const shuffledAnswers = question.answers.map((answer, index) => ({
                    answer: answer,
                    originalIndex: index
                })).sort(() => Math.random() - 0.5);
                
                shuffledAnswers.forEach(item => {
                    html += `
                        <button class="answer-btn" onclick="selectAnswer(${item.originalIndex})">
                            ${item.answer.text}
                        </button>
                    `;
                });
                break;
                
            case 'order':
                html += '<div class="order-container">';
                // Mélanger les réponses
                const shuffled = [...question.answers].sort(() => Math.random() - 0.5);
                shuffled.forEach((answer, index) => {
                    html += `
                        <div class="order-item" draggable="true" data-text="${answer.text}" data-original-order="${answer.order}">
                            <span class="drag-handle">☰</span>
                            <span class="order-text">${answer.text}</span>
                        </div>
                    `;
                });
                html += '</div>';
                html += '<button class="btn-validate-order" onclick="validateOrder()">Valider l\'ordre</button>';
                break;
                
            case 'freetext':
                html += `
                    <div class="freetext-container">
                        <textarea id="freetext-answer" 
                                  class="freetext-input" 
                                  placeholder="Tapez votre réponse ici..."
                                  maxlength="300"
                                  rows="4"></textarea>
                        <div class="freetext-counter">
                            <span id="freetext-count">0</span> / 300 caractères
                        </div>
                        <button class="btn-validate-freetext" onclick="validateFreeText()">Valider ma réponse</button>
                    </div>
                `;
                break;
        }
        
        html += `
                </div>
            </div>
        `;
        
        gameContainer.innerHTML = html;
        
        // Démarrer le timer
        startQuestionTimer(question.time);
        
        // Initialiser le drag & drop si question d'ordre
        if (question.type === 'order') {
            initializeOrderDragDrop();
        }
        
        // Initialiser le compteur de caractères si question à réponse libre
        if (question.type === 'freetext') {
            const textarea = document.getElementById('freetext-answer');
            const counter = document.getElementById('freetext-count');
            if (textarea && counter) {
                textarea.addEventListener('input', function() {
                    counter.textContent = this.value.length;
                });
            }
        }
    }

    let timerState = {
        isPaused: false,
        remaining: 0,
        duration: 0,
        interval: null
    };
    
    let countdownState = {
        isPaused: false,
        remaining: 10,
        interval: null
    };

    function startQuestionTimer(duration) {
        const timerBar = document.getElementById('timer-bar');
        const timerText = document.getElementById('timer-text');
        
        timerState.remaining = duration;
        timerState.duration = duration;
        timerState.isPaused = false;
        timerBar.style.width = '100%';
        
        if (timerState.interval) {
            clearInterval(timerState.interval);
        }
        
        timerState.interval = setInterval(() => {
            if (timerState.isPaused) {
                return; // Ne rien faire si en pause
            }
            
            timerState.remaining--;
            const percentage = (timerState.remaining / timerState.duration) * 100;
            
            if (timerBar && timerText) {
                timerBar.style.width = percentage + '%';
                timerText.textContent = timerState.remaining + 's';
                
                // Changer de couleur quand proche de la fin
                if (timerState.remaining <= 5) {
                    timerBar.style.background = 'var(--error)';
                }
            }
            
            if (timerState.remaining <= 0 || hasAnswered) {
                clearInterval(timerState.interval);
                timerState.interval = null;
                if (!hasAnswered) {
                    // Temps écoulé sans réponse
                    autoSubmitNoAnswer();
                }
            }
        }, 1000);
        
        answerTimeout = timerState.interval;
    }
    
    function handlePause(isPaused) {
        timerState.isPaused = isPaused;
        countdownState.isPaused = isPaused;
        
        // Afficher/masquer l'overlay de pause
        if (isPaused) {
            showPauseOverlay();
        } else {
            hidePauseOverlay();
        }
        
        // Gérer le timer de question
        const timerBar = document.getElementById('timer-bar');
        const timerText = document.getElementById('timer-text');
        
        if (timerBar && timerText && timerState.remaining > 0) {
            if (isPaused) {
                timerText.textContent = '⏸️ ' + timerState.remaining + 's';
                timerBar.style.opacity = '0.5';
            } else {
                timerText.textContent = timerState.remaining + 's';
                timerBar.style.opacity = '1';
            }
        }
        
        // Gérer le countdown du top 3
        const countdownEl = document.getElementById('countdown-next');
        if (countdownEl && countdownState.remaining > 0) {
            if (isPaused) {
                countdownEl.textContent = '⏸️ ' + countdownState.remaining;
            } else {
                countdownEl.textContent = countdownState.remaining;
            }
        }
    }
    
    function showPauseOverlay() {
        // Supprimer l'ancien overlay s'il existe
        let overlay = document.getElementById('pause-overlay');
        if (overlay) return;
        
        // Créer l'overlay
        overlay = document.createElement('div');
        overlay.id = 'pause-overlay';
        overlay.innerHTML = `
            <div class="pause-content">
                <div class="pause-icon">⏸️</div>
                <h2>Partie en pause</h2>
                <p>Le professeur a mis le jeu en pause.<br>Merci de patienter...</p>
            </div>
        `;
        document.body.appendChild(overlay);
    }
    
    function hidePauseOverlay() {
        const overlay = document.getElementById('pause-overlay');
        if (overlay) {
            overlay.remove();
        }
    }

    async function selectAnswer(index) {
        console.log('🔵 selectAnswer appelé:', { hasAnswered, isPaused: timerState.isPaused });
        if (hasAnswered || timerState.isPaused === true) return;
        
        hasAnswered = true;
        const timeSpent = Date.now() - questionStartTime; // Millisecondes
        
        // Désactiver tous les boutons
        document.querySelectorAll('.answer-btn').forEach((btn, i) => {
            btn.disabled = true;
            if (i === index) {
                btn.classList.add('selected');
            }
        });
        
        // Envoyer la réponse
        await submitAnswer({ index }, timeSpent);
        
        // Afficher un feedback
        showAnswerFeedback();
    }

    async function validateOrder() {
        if (hasAnswered || timerState.isPaused === true) return;
        
        hasAnswered = true;
        const timeSpent = Date.now() - questionStartTime; // Millisecondes
        
        // Récupérer l'ordre actuel
        const items = document.querySelectorAll('.order-item');
        const userOrder = Array.from(items).map(item => item.getAttribute('data-text'));
        
        // Désactiver le bouton
        event.target.disabled = true;
        event.target.textContent = '✅ Réponse envoyée';
        
        // Envoyer la réponse
        await submitAnswer({ order: userOrder }, timeSpent);
        
        // Afficher un feedback
        showAnswerFeedback();
    }

    async function autoSubmitNoAnswer() {
        if (hasAnswered) return;
        
        hasAnswered = true;
        const timeSpent = currentQuestionData.question.time;
        
        // Envoyer une réponse vide
        await submitAnswer({ index: -1 }, timeSpent);
        
        // Afficher un feedback
        showAnswerFeedback('Temps écoulé ! ⏰');
    }

    function showAnswerFeedback(message = 'Réponse enregistrée ! ✅') {
        const container = document.getElementById('answers-container');
        if (!container) {
            return; // La page a changé, ne rien faire
        }
        container.innerHTML = `
            <div class="answer-feedback">
                <div class="feedback-icon">✓</div>
                <div class="feedback-text">${message}</div>
                <div class="feedback-subtext">En attente des autres joueurs...</div>
            </div>
        `;
    }

    // ========================================
    // DRAG & DROP POUR ORDRE
    // ========================================
    
    function initializeOrderDragDrop() {
        const items = document.querySelectorAll('.order-item');
        let draggedItem = null;
        
        items.forEach(item => {
            item.addEventListener('dragstart', function(e) {
                draggedItem = this;
                setTimeout(() => this.classList.add('dragging'), 0);
            });
            
            item.addEventListener('dragend', function() {
                this.classList.remove('dragging');
            });
            
            item.addEventListener('dragover', function(e) {
                e.preventDefault();
                const afterElement = getDragAfterElement(this.parentElement, e.clientY);
                if (afterElement == null) {
                    this.parentElement.appendChild(draggedItem);
                } else {
                    this.parentElement.insertBefore(draggedItem, afterElement);
                }
            });
        });
    }

    function getDragAfterElement(container, y) {
        const draggableElements = [...container.querySelectorAll('.order-item:not(.dragging)')];
        
        return draggableElements.reduce((closest, child) => {
            const box = child.getBoundingClientRect();
            const offset = y - box.top - box.height / 2;
            
            if (offset < 0 && offset > closest.offset) {
                return { offset: offset, element: child };
            } else {
                return closest;
            }
        }, { offset: Number.NEGATIVE_INFINITY }).element;
    }

    // ========================================
    // RÉSULTATS DE LA QUESTION
    // ========================================
    
    function generateQuestionStatsHTML(data, myData, allPlayers) {
        console.log('📊 generateQuestionStatsHTML appelé');
        console.log('📊 data.questionStats:', data.questionStats);
        console.log('📊 myData:', myData);
        console.log('📊 SESSION_STATE.playerNickname:', SESSION_STATE.playerNickname);
        
        if (!data.questionStats) {
            console.warn('⚠️ Pas de questionStats dans data');
            return `
                <div class="question-stats-container">
                    <h3 class="section-title">📝 Question précédente</h3>
                    <p style="color: red;">DEBUG: Pas de questionStats reçu du serveur</p>
                </div>
            `;
        }
        
        // Trouver mes stats pour cette question
        const myStats = data.questionStats.find(s => s.nickname === SESSION_STATE.playerNickname);
        
        console.log('📊 myStats trouvé:', myStats);
        
        if (!myStats) {
            console.warn('⚠️ Pas de stats pour mon pseudo');
            const receivedNicknames = data.questionStats.map(s => s.nickname).join(', ');
            return `
                <div class="question-stats-container">
                    <h3 class="section-title">📝 Question précédente</h3>
                    <p style="color: orange;">DEBUG: Stats non trouvées pour "${SESSION_STATE.playerNickname}"</p>
                    <p>Pseudos reçus: ${receivedNicknames}</p>
                    <p>Nombre de stats: ${data.questionStats.length}</p>
                </div>
            `;
        }
        
        if (!myStats) return '';
        
        const isCorrect = myStats.correct;
        const timeSpent = myStats.timeSpent || 0;
        const pointsEarned = myStats.pointsEarned || 0;
        
        // Convertir en millièmes (3 décimales)
        const timeDisplay = (timeSpent / 1000).toFixed(3);
        
        let html = `
            <div class="question-stats-container">
                <h3 class="section-title">📝 Question précédente</h3>
                
                <div class="question-result-centered">
                    <div class="question-result ${isCorrect ? 'correct' : 'incorrect'}">
                        <div class="result-icon">${isCorrect ? '✅' : '❌'}</div>
                        <div class="result-text">
                            <div class="result-label">${isCorrect ? 'Bonne réponse !' : 'Mauvaise réponse'}</div>
                            ${isCorrect ? `
                                <div class="result-details">
                                    ⏱️ Ton temps de réponse : ${timeDisplay}s
                                </div>
                                <div class="result-points">
                                    🎯 +${pointsEarned} pts
                                </div>
                            ` : ''}
                        </div>
                    </div>
                </div>
        `;
        
        // Top 5 des plus rapides
        if (data.top5Fastest && data.top5Fastest.length > 0) {
            html += `
                <div class="top5-fastest">
                    <h4>⚡ Top 5 des plus rapides</h4>
                    <div class="fastest-list">
            `;
            
            data.top5Fastest.forEach((player, index) => {
                const fastTime = (player.timeSpent / 1000).toFixed(3);
                const isMe = player.nickname === SESSION_STATE.playerNickname;
                html += `
                    <div class="fastest-item ${isMe ? 'is-me' : ''}">
                        <span class="fastest-rank">#${index + 1}</span>
                        <span class="fastest-name">${player.nickname}</span>
                        <span class="fastest-time">⏱️ ${fastTime}s</span>
                        <span class="fastest-points">🎯 ${player.pointsEarned}pts</span>
                    </div>
                `;
            });
            
            html += `
                    </div>
                </div>
            `;
        }
        
        html += `
                <div class="ranking-actions">
                    <button class="btn-secondary" onclick="showFullRanking()">
                        📋 Voir classement général
                    </button>
                </div>
            </div>
        `;
        
        return html;
    }
    
    function displayQuestionResults(data) {
        console.log('📊 ÉLÈVE: Affichage résultats', data);
        console.log('🔍 data.manualMode =', data.manualMode, ', type =', typeof data.manualMode);
        
        // Vérifier si c'est la dernière question
        const totalQuestions = SESSION_STATE.quizData?.totalQuestions || SESSION_STATE.quizData?.questions?.length || 0;
        
        // Si totalQuestions est 0, on ne peut pas savoir, donc on affiche le Top 3
        if (totalQuestions > 0) {
            const isLastQuestion = data.questionIndex >= (totalQuestions - 1);
            
            console.log(`🔍 Question ${data.questionIndex + 1}/${totalQuestions}, dernière=${isLastQuestion}`);
            
            if (isLastQuestion) {
                // Dernière question : afficher directement les résultats finaux
                console.log('🏁 ÉLÈVE: Dernière question, affichage résultats finaux');
                displayFinalResults(data);
                return;
            }
        } else {
            console.warn('⚠️ ÉLÈVE: totalQuestions inconnu, affichage Top 3 par défaut');
        }
        
        const gameContainer = document.querySelector('.game-container');
        
        // Debug complet des données reçues
        console.log('📊 DONNÉES REÇUES:', {
            hasQuestionStats: !!data.questionStats,
            questionStats: data.questionStats,
            hasAllPlayers: !!data.allPlayers,
            hasPlayers: !!data.players,
            playersCount: (data.allPlayers || data.players || []).length
        });
        
        // Utiliser allPlayers si disponible, sinon players
        const players = data.allPlayers || data.players || [];
        
        if (players.length === 0) {
            console.error('❌ Aucun joueur dans les résultats');
            return;
        }
        
        // Trouver ma position et mon score
        const myData = players.find(p => p.nickname === SESSION_STATE.playerNickname);
        const myScore = myData ? myData.score : 0;
        const myPosition = myData ? players.indexOf(myData) + 1 : '-';
        
        // Top 3
        const top3 = data.top3 || players.slice(0, 3);
        
        let html = `
            <div class="results-screen">
                <h2>📊 Résultats</h2>
                
                <div class="my-results">
                    <div class="my-stats-row">
                        <div class="my-nickname">
                            ${SESSION_STATE.playerNickname}
                        </div>
                        <div class="my-score">
                            <div class="score-label">Score total</div>
                            <div class="score-value">${myScore} pts</div>
                        </div>
                        <div class="my-position">
                            <div class="position-label">Ta position</div>
                            <div class="position-value">#${myPosition}</div>
                        </div>
                    </div>
                </div>
                
                ${generateQuestionStatsHTML(data, myData, players)}
                
                <div class="waiting-next">
                    ${data.manualMode ? 
                        '<p>🎯 En attente du professeur pour la prochaine question...</p>' :
                        '<p>⏳ Prochaine question dans <span id="countdown-next">10</span>s...</p>'
                    }
                    <div class="dots-loader">
                        <span></span><span></span><span></span>
                    </div>
                </div>
            </div>
        `;
        
        gameContainer.innerHTML = html;
        
        // Stocker les données pour le classement complet
        window.currentRankingData = players;
        
        console.log('🔍 Mode manuel:', data.manualMode);
        
        // Démarrer le compte à rebours seulement en mode automatique
        if (!data.manualMode) {
            countdownState.remaining = 10;
            countdownState.isPaused = false;
            
            const countdownEl = document.getElementById('countdown-next');
        
            if (countdownState.interval) {
                clearInterval(countdownState.interval);
            }
            
            countdownState.interval = setInterval(() => {
                if (countdownState.isPaused) {
                    return; // Ne rien faire si en pause
                }
                
                countdownState.remaining--;
                if (countdownEl) {
                    countdownEl.textContent = countdownState.remaining;
                }
                if (countdownState.remaining <= 0) {
                    clearInterval(countdownState.interval);
                    countdownState.interval = null;
                }
            }, 1000);
        }
    }
    
    function showFullRanking() {
        const players = window.currentRankingData || [];
        
        // Créer la modale
        let html = `
            <div class="modal-overlay" onclick="closeFullRanking()">
                <div class="modal-content ranking-modal" onclick="event.stopPropagation()">
                    <div class="modal-header">
                        <h3>📊 Classement complet</h3>
                        <button class="modal-close" onclick="closeFullRanking()">✕</button>
                    </div>
                    
                    <div class="ranking-list">
        `;
        
        players.forEach((player, index) => {
            const isMe = player.nickname === SESSION_STATE.playerNickname;
            html += `
                <div class="ranking-item ${isMe ? 'is-me' : ''}">
                    <div class="ranking-position">#${index + 1}</div>
                    <div class="ranking-avatar">${player.nickname.split(' ')[0]}</div>
                    <div class="ranking-name">${player.nickname.split(' ')[1]}</div>
                    <div class="ranking-score">${player.score || 0} pts</div>
                </div>
            `;
        });
        
        // Vérifier si un countdown est actif
        const hasCountdown = document.getElementById('countdown-next') !== null;
        
        html += `
                    </div>
                    ${hasCountdown ? `
                    <div class="modal-footer">
                        <p class="countdown-text">⏳ Prochaine question dans <span id="countdown-modal">--</span>s</p>
                    </div>
                    ` : ''}
                </div>
            </div>
        `;
        
        // Ajouter au body
        const modalDiv = document.createElement('div');
        modalDiv.id = 'full-ranking-modal';
        modalDiv.innerHTML = html;
        document.body.appendChild(modalDiv);
        
        // Synchroniser le compte à rebours seulement s'il existe
        if (hasCountdown) {
            syncCountdown();
        }
    }
    
    function closeFullRanking() {
        const modal = document.getElementById('full-ranking-modal');
        if (modal) {
            modal.remove();
        }
    }
    
    function syncCountdown() {
        // Synchroniser le compte à rebours entre la page et la modale
        const mainCountdown = document.getElementById('countdown-next');
        const modalCountdown = document.getElementById('countdown-modal');
        
        if (mainCountdown && modalCountdown) {
            // Mettre à jour immédiatement
            modalCountdown.textContent = mainCountdown.textContent;
            
            // Synchroniser en continu
            const syncInterval = setInterval(() => {
                if (mainCountdown && modalCountdown && document.getElementById('full-ranking-modal')) {
                    modalCountdown.textContent = mainCountdown.textContent;
                } else {
                    clearInterval(syncInterval);
                }
            }, 100);
        }
    }

    // ========================================
    // FIN DE PARTIE
    // ========================================
    
    function displayFinalResults(data) {
        const gameContainer = document.querySelector('.game-container');
        
        // Arrêter TOUS les timers actifs
        if (timerState.interval) {
            clearInterval(timerState.interval);
            timerState.interval = null;
        }
        if (countdownState.interval) {
            clearInterval(countdownState.interval);
            countdownState.interval = null;
        }
        
        // Utiliser allPlayers si disponible
        const players = data.allPlayers || data.players || [];
        
        if (players.length === 0) {
            console.error('❌ Aucun joueur dans les résultats finaux');
            return;
        }
        
        // Trouver ma position
        const myData = players.find(p => p.nickname === SESSION_STATE.playerNickname);
        const myPosition = myData ? players.indexOf(myData) + 1 : '-';
        const myScore = myData ? myData.score : 0;
        
        // Top 3
        const top3 = players.slice(0, 3);
        
        let html = `
            <div class="final-screen">
                <h2>🎉 Partie terminée !</h2>
                
                <div class="final-my-results">
                    <div class="final-position">#${myPosition}</div>
                    <div class="final-score">${myScore} points</div>
                    ${myPosition <= 3 ? '<div class="final-badge">🏆 Top 3 !</div>' : ''}
                </div>
                
                <div class="final-top3">
                    <h3>🏆 Podium final</h3>
                    <div class="final-podium">
        `;
        
        const medals = ['🥇', '🥈', '🥉'];
        
        // Ordre d'affichage : 2ème, 1er, 3ème
        // Hauteurs : 2ème = moyen, 1er = haut, 3ème = bas
        const displayOrder = [1, 0, 2]; // Indices dans top3
        const heights = ['100px', '140px', '80px']; // Hauteurs correspondantes
        
        displayOrder.forEach((originalIndex, displayIndex) => {
            if (originalIndex >= top3.length) return; // Pas assez de joueurs
            
            const player = top3[originalIndex];
            const isMe = player.nickname === SESSION_STATE.playerNickname;
            const rank = originalIndex + 1;
            
            html += `
                <div class="final-podium-item rank-${rank} ${isMe ? 'is-me' : ''}" style="height: ${heights[displayIndex]}">
                    <div class="final-rank">#${rank}</div>
                    <div class="final-medal">${medals[originalIndex]}</div>
                    <div class="final-avatar">${player.nickname.split(' ')[0]}</div>
                    <div class="final-name">${player.nickname.split(' ')[1]}</div>
                    <div class="final-points">${player.score} pts</div>
                </div>
            `;
        });
        
        html += `
                    </div>
                    
                    <div class="ranking-actions" style="margin-top: var(--space-lg);">
                        <button class="btn-secondary" onclick="showFullRanking()">
                            📋 Voir le classement complet
                        </button>
                    </div>
                </div>
                
                <div class="final-actions">
                    <button class="btn-home" onclick="goBackHome()">
                        🏠 Retour à l'accueil
                    </button>
                </div>
            </div>
        `;
        
        gameContainer.innerHTML = html;
        
        // Stocker les données pour le classement complet
        window.currentRankingData = players;
        
        // Lancer des confettis si dans le top 3
        if (myPosition <= 3) {
            launchConfetti();
        }
    }

    function goBackHome() {
        leaveSession();
        showPage('home-page');
        document.getElementById('quiz-code-input').value = '';
        document.getElementById('quiz-code-input').focus();
    }

    function launchConfetti() {
        // Animation simple de confettis
        const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8'];
        const confettiCount = 50;
        
        for (let i = 0; i < confettiCount; i++) {
            setTimeout(() => {
                const confetti = document.createElement('div');
                confetti.className = 'confetti';
                confetti.style.left = Math.random() * 100 + '%';
                confetti.style.background = colors[Math.floor(Math.random() * colors.length)];
                confetti.style.animationDuration = (Math.random() * 3 + 2) + 's';
                document.body.appendChild(confetti);
                
                setTimeout(() => confetti.remove(), 5000);
            }, i * 30);
        }
    }

    async function validateFreeText() {
        if (hasAnswered || timerState.isPaused === true) return;
        
        hasAnswered = true;
        const timeSpent = Date.now() - questionStartTime; // Millisecondes
        
        const textarea = document.getElementById('freetext-answer');
        const userAnswer = textarea.value.trim();
        
        // Désactiver le textarea et le bouton
        textarea.disabled = true;
        const btn = document.querySelector('.btn-validate-freetext');
        if (btn) {
            btn.disabled = true;
            btn.classList.add('selected');
        }
        
        // Envoyer la réponse
        await submitAnswer({ freetext: userAnswer }, timeSpent);
        
        // Afficher un feedback
        showAnswerFeedback();
    }

    // ========================================
    // EXPORT VERS GLOBAL
    // ========================================
    
    window.showStudentJoinPage = showStudentJoinPage;
    window.selectAnimal = selectAnimal;
    window.confirmJoinGame = confirmJoinGame;
    window.updateWaitingRoom = updateWaitingRoom;
    window.handleGameStart = handleGameStart;
    window.displayQuestion = displayQuestion;
    window.selectAnswer = selectAnswer;
    window.validateOrder = validateOrder;
    window.validateFreeText = validateFreeText;
    window.displayQuestionResults = displayQuestionResults;
    window.displayFinalResults = displayFinalResults;
    window.showFullRanking = showFullRanking;
    window.closeFullRanking = closeFullRanking;
    window.handlePause = handlePause;
    window.goBackHome = goBackHome;

})();
