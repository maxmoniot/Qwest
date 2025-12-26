// ============================================
// MODULE: IMPORT/EXPORT LOCAL
// Description: Import/Export de questionnaires en JSON
// ============================================

(function() {
    'use strict';

    /**
     * Exporter le questionnaire en JSON
     */
    window.exportQuizLocally = function() {
        if (APP_STATE.questions.length === 0) {
            alert('❌ Aucune question à exporter !');
            return;
        }
        
        const quizName = document.getElementById('quiz-name-input').value.trim();
        if (!quizName) {
            alert('⚠️ Veuillez entrer un nom pour le questionnaire');
            return;
        }
        
        // Créer l'objet JSON
        const exportData = {
            name: quizName,
            version: "1.0",
            createdAt: new Date().toISOString(),
            questionsCount: APP_STATE.questions.length,
            questions: APP_STATE.questions.map(q => {
                const questionData = {
                    type: q.type,
                    question: q.question,
                    time: q.time,
                    answers: q.answers.map(a => ({
                        text: a.text,
                        correct: a.correct || false,
                        order: a.order !== undefined ? a.order : undefined
                    }))
                };
                
                // Ajouter imageUrl si présent
                if (q.imageUrl) {
                    questionData.imageUrl = q.imageUrl;
                }
                
                // Ajouter les propriétés spécifiques à freetext
                if (q.type === 'freetext') {
                    if (q.caseSensitive !== undefined) {
                        questionData.caseSensitive = q.caseSensitive;
                    }
                    if (q.acceptedAnswers) {
                        questionData.acceptedAnswers = q.acceptedAnswers;
                    }
                }
                
                return questionData;
            })
        };
        
        // Convertir en JSON lisible
        const jsonString = JSON.stringify(exportData, null, 2);
        
        // Créer le fichier et télécharger
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${quizName.replace(/[^a-z0-9]/gi, '_')}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        showMessage('save-message', '✅ Questionnaire exporté avec succès !', 'success');
        
        setTimeout(() => {
            closeSaveQuizModal();
        }, 1500);
    };

    /**
     * Ouvrir le sélecteur de fichier
     */
    window.importQuizLocally = function() {
        document.getElementById('import-file-input').click();
    };

    /**
     * Traiter le fichier importé
     */
    window.handleImportFile = function(event) {
        const file = event.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const data = JSON.parse(e.target.result);
                
                // Valider le format
                if (!data.questions || !Array.isArray(data.questions)) {
                    throw new Error('Format invalide : questions manquantes');
                }
                
                // Valider chaque question
                data.questions.forEach((q, index) => {
                    if (!q.type || !q.question || !q.answers) {
                        throw new Error(`Question ${index + 1} invalide`);
                    }
                    
                    // Valider le type
                    if (!['multiple', 'truefalse', 'order', 'freetext'].includes(q.type)) {
                        throw new Error(`Question ${index + 1} : type "${q.type}" invalide`);
                    }
                    
                    // Valider answers
                    if (!Array.isArray(q.answers) || q.answers.length === 0) {
                        throw new Error(`Question ${index + 1} : réponses manquantes`);
                    }
                });
                
                // Import réussi - charger les questions
                APP_STATE.questions = data.questions.map(q => {
                    const question = new Question(q.type);
                    question.question = q.question;
                    question.time = q.time;
                    
                    // Copier les réponses (pas juste référence)
                    question.answers = JSON.parse(JSON.stringify(q.answers));
                    
                    // Importer imageUrl si présent
                    if (q.imageUrl) {
                        question.imageUrl = q.imageUrl;
                    }
                    
                    // Importer les propriétés spécifiques à freetext
                    if (q.type === 'freetext') {
                        if (q.caseSensitive !== undefined) {
                            question.caseSensitive = q.caseSensitive;
                        }
                        if (q.acceptedAnswers) {
                            question.acceptedAnswers = q.acceptedAnswers;
                        }
                    }
                    
                    return question;
                });
                
                renderQuestionsList();
                updateHeaderButtons();
                
                showMessage('load-message', `✅ ${data.questions.length} question(s) importée(s) !`, 'success');
                
                setTimeout(() => {
                    closeLoadQuizModal();
                }, 1500);
                
            } catch (error) {
                console.error('Erreur import:', error);
                showMessage('load-message', `❌ Erreur : ${error.message}`, 'error');
            }
        };
        
        reader.readAsText(file);
        
        // Reset input
        event.target.value = '';
    };

})();
