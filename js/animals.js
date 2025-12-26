// ============================================
// MODULE: ANIMAUX (Pseudos élèves)
// Description: Liste d'animaux pour les pseudos élèves
// ============================================

(function() {
    'use strict';

    // Liste exhaustive d'animaux (120+ pour couvrir une classe entière)
    const ALL_ANIMALS = [
        // Mammifères terrestres
        '🦁 Lion', '🐯 Tigre', '🐻 Ours', '🐼 Panda', '🦊 Renard',
        '🐺 Loup', '🦝 Raton laveur', '🐨 Koala', '🐹 Hamster', '🐰 Lapin',
        '🦔 Hérisson', '🐿️ Écureuil', '🦫 Castor', '🦘 Kangourou', '🦙 Lama',
        '🦒 Girafe', '🦏 Rhinocéros', '🦛 Hippopotame', '🐘 Éléphant', '🐆 Léopard',
        '🐅 Tigre', '🦓 Zèbre', '🦌 Cerf', '🐃 Buffle', '🐂 Bœuf',
        '🐄 Vache', '🐎 Cheval', '🦬 Bison', '🐖 Cochon', '🐏 Mouton',
        '🐐 Chèvre', '🦙 Alpaga', '🦦 Loutre', '🦨 Mouffette', '🦡 Blaireau',
        
        // Animaux domestiques et de ferme
        '🐕 Chien', '🐩 Caniche', '🐈 Chat', '🐈‍⬛ Chat noir', '🐓 Coq',
        '🦃 Dinde', '🦆 Canard', '🦢 Cygne', '🦜 Perroquet', '🦩 Flamant',
        '🐁 Souris', '🐀 Rat', '🐇 Lapin blanc', '🦙 Lama blanc',
        
        // Créatures marines
        '🐋 Baleine', '🐳 Cachalot', '🐬 Dauphin', '🦈 Requin', '🐙 Pieuvre',
        '🦑 Calmar', '🦀 Crabe', '🦞 Homard', '🐠 Poisson', '🐡 Poisson-globe',
        '🐟 Poisson tropical', '🦭 Phoque', '🦦 Loutre', '🐢 Tortue', '🦎 Lézard',
        '🦐 Crevette', '🦪 Huître', '🐚 Coquillage', '🦑 Seiche', '🐡 Fugu',
        
        // Oiseaux
        '🦅 Aigle', '🦉 Hibou', '🦚 Paon', '🦤 Dodo', '🐧 Pingouin',
        '🐦 Oiseau', '🐤 Poussin', '🐥 Caneton', '🦢 Cygne', '🕊️ Colombe',
        '🦃 Dindon', '🦜 Ara', '🦩 Flamant rose', '🐓 Poulet', '🦆 Colvert',
        '🦅 Faucon', '🦉 Chouette', '🐦‍⬛ Corbeau', '🦇 Pipistrelle',
        
        // Insectes et petites créatures
        '🐝 Abeille', '🐛 Chenille', '🦋 Papillon', '🐌 Escargot', '🐞 Coccinelle',
        '🦗 Criquet', '🕷️ Araignée', '🦂 Scorpion', '🦟 Moustique', '🪲 Scarabée',
        '🐜 Fourmi', '🪰 Mouche', '🦟 Libellule', '🪳 Cafard', '🐛 Ver',
        
        // Reptiles et amphibiens
        '🐍 Serpent', '🦕 Dinosaure', '🦖 T-Rex', '🐊 Crocodile', '🐸 Grenouille',
        '🦎 Gecko', '🐢 Tortue marine', '🐊 Alligator', '🦎 Caméléon', '🐸 Rainette',
        
        // Animaux sauvages
        '🦁 Lionne', '🐯 Tigresse', '🐻‍❄️ Ours polaire', '🦊 Renarde', '🐺 Louve',
        '🦝 Raton', '🦘 Wallaby', '🦙 Guanaco', '🐆 Jaguar', '🐅 Panthère',
        
        // Créatures mythiques et exotiques
        '🦄 Licorne', '🐉 Dragon', '🦇 Chauve-souris', '🦔 Hérisson', '🦦 Loutre de mer',
        
        // Animaux africains
        '🦓 Zèbre', '🦒 Girafe', '🦏 Rhino', '🦛 Hippo', '🐘 Éléphant',
        '🦁 Lion', '🐆 Guépard', '🦘 Émeu', '🦩 Flamant', '🦜 Perruche'
    ];

    // Stockage des animaux utilisés par session
    const usedAnimals = new Map(); // sessionId -> Set d'animaux utilisés

    /**
     * Obtenir 3 animaux aléatoires non utilisés pour une session
     */
    function getRandomAnimals(sessionId, count = 3) {
        // Initialiser le set des animaux utilisés pour cette session
        if (!usedAnimals.has(sessionId)) {
            usedAnimals.set(sessionId, new Set());
        }
        
        const used = usedAnimals.get(sessionId);
        const available = ALL_ANIMALS.filter(animal => !used.has(animal));
        
        // Si moins de 3 animaux disponibles, réinitialiser
        if (available.length < count) {
            used.clear();
            return getRandomAnimals(sessionId, count);
        }
        
        // Sélectionner aléatoirement
        const selected = [];
        const availableCopy = [...available];
        
        for (let i = 0; i < count; i++) {
            const randomIndex = Math.floor(Math.random() * availableCopy.length);
            const animal = availableCopy.splice(randomIndex, 1)[0];
            selected.push(animal);
            used.add(animal);
        }
        
        return selected;
    }

    /**
     * Réserver un animal pour un élève
     */
    function reserveAnimal(sessionId, animal) {
        if (!usedAnimals.has(sessionId)) {
            usedAnimals.set(sessionId, new Set());
        }
        usedAnimals.get(sessionId).add(animal);
    }

    /**
     * Libérer un animal (si élève se déconnecte)
     */
    function releaseAnimal(sessionId, animal) {
        if (usedAnimals.has(sessionId)) {
            usedAnimals.get(sessionId).delete(animal);
        }
    }

    /**
     * Réinitialiser les animaux d'une session
     */
    function resetSession(sessionId) {
        usedAnimals.delete(sessionId);
    }

    /**
     * Obtenir la liste de tous les animaux disponibles
     */
    function getAllAnimals() {
        return [...ALL_ANIMALS];
    }

    /**
     * Obtenir un animal aléatoire unique
     */
    function getUniqueAnimal(sessionId, excludeList = []) {
        if (!usedAnimals.has(sessionId)) {
            usedAnimals.set(sessionId, new Set());
        }
        
        const used = usedAnimals.get(sessionId);
        const available = ALL_ANIMALS.filter(animal => 
            !used.has(animal) && !excludeList.includes(animal)
        );
        
        if (available.length === 0) {
            // Tous les animaux sont utilisés, réinitialiser
            used.clear();
            return getUniqueAnimal(sessionId, excludeList);
        }
        
        const randomIndex = Math.floor(Math.random() * available.length);
        const animal = available[randomIndex];
        used.add(animal);
        
        return animal;
    }

    // ========================================
    // EXPORT VERS GLOBAL
    // ========================================
    
    window.ANIMALS = {
        getRandomAnimals,
        reserveAnimal,
        releaseAnimal,
        resetSession,
        getAllAnimals,
        getUniqueAnimal,
        count: ALL_ANIMALS.length
    };

})();
