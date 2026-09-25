import type { Messages } from './en.js';

export const fr: Messages = {
  errors: {
    http: {
      unauthorized: 'Vous devez vous connecter pour faire cela',
      forbidden: "Vous n'êtes pas autorisé à faire cela",
      notFound: 'Introuvable',
      internal: 'Une erreur est survenue, veuillez réessayer',
      unexpected: 'Une erreur est survenue, veuillez réessayer',
    },
    auth: {
      invalidCredentials: 'Identifiants invalides',
      invalidRefreshToken: 'Jeton de rafraîchissement invalide',
      emailTaken: 'Cet e-mail est déjà enregistré',
      phoneTaken: 'Ce numéro de téléphone est déjà enregistré',
      emailOrPhoneTaken:
        'Cet e-mail ou ce numéro de téléphone est déjà enregistré',
    },
    phone: {
      invalid:
        'Saisissez un numéro de téléphone valide avec son indicatif pays, p. ex. +221 77 123 45 67',
      notFound: 'Numéro de téléphone introuvable',
      max: 'Vous pouvez ajouter jusqu’à {max} numéros supplémentaires',
      inUse: 'Ce numéro est déjà utilisé',
    },
    users: {
      notFound: 'Utilisateur introuvable',
      ntrpStep: 'ntrpRating doit être un multiple de 0,5',
    },
    clubs: { notFound: 'Club introuvable' },
    courts: { notFound: 'Court introuvable' },
    bookings: {
      notFound: 'Réservation introuvable',
      endBeforeStart: 'endTime doit être postérieur à startTime',
      startInPast: 'startTime doit être dans le futur',
      slotTaken: 'Ce court est déjà réservé pour la plage horaire demandée',
      cannotCancel:
        'Impossible d’annuler une réservation déjà commencée ou passée',
    },
    products: {
      notFound: 'Produit introuvable',
      notOwner: 'Ce produit ne vous appartient pas',
      unknownCategory: 'Catégorie de produit inconnue « {code} »',
    },
    purchaseRequests: {
      notFound: 'Demande d’achat introuvable',
      ownProduct:
        'Vous ne pouvez pas envoyer une demande d’achat pour votre propre produit',
      unavailable: "Cet article n'est plus disponible",
      alreadyActive:
        'Vous avez déjà une demande d’achat active pour cet article',
      onlySeller: 'Seul le vendeur peut répondre à cette demande d’achat',
      notPending: "Cette demande d’achat n'est plus en attente",
      notYours: "Ce n'est pas votre demande d’achat",
      onlyPendingCancel: 'Seules les demandes en attente peuvent être annulées',
    },
    competitions: {
      notFound: 'Tournoi introuvable',
      closed: 'Les inscriptions à ce tournoi sont closes',
      full: 'Ce tournoi est complet',
      started: 'Ce tournoi a déjà commencé',
    },
    matches: {
      notFound: 'Match introuvable',
      pickOpponent: 'Choisissez un adversaire ou saisissez un nom',
      selfPlay: 'Vous ne pouvez pas jouer contre vous-même',
      opponentNotFound: 'Adversaire introuvable',
      endBeforeStart: 'Le match ne peut pas se terminer avant son début',
      playTimeTooLong: 'Le temps de jeu ne peut pas dépasser la durée totale',
      needsWinner: 'Un match terminé doit avoir un vainqueur',
      needsScore: 'Un match terminé doit avoir un score',
      onlyRecorderDeletes:
        'Seul le joueur qui a enregistré le match peut le supprimer',
    },
    notifications: { notFound: 'Notification introuvable' },
    uploads: {
      noFile: 'Aucun fichier fourni',
      invalidFolder:
        'Dossier de téléversement invalide « {folder} ». Dossiers autorisés : {allowed}',
      unsupportedType:
        'Type de fichier non pris en charge « {type} ». Types autorisés : {allowed}',
      tooLarge: 'Fichier trop volumineux : la taille maximale est de {max} Mo',
    },
  },
  validation: {
    invalid: '{property} est invalide',
    isEmail: '{property} doit être une adresse e-mail valide',
    isString: '{property} doit être une chaîne de caractères',
    minLength: '{property} doit contenir au moins {min} caractères',
    maxLength: '{property} doit contenir au plus {max} caractères',
    min: '{property} ne doit pas être inférieur à {min}',
    max: '{property} ne doit pas être supérieur à {max}',
    isInt: '{property} doit être un entier',
    isNumber: '{property} doit être un nombre',
    isPositive: '{property} doit être un nombre positif',
    isBoolean: '{property} doit être un booléen',
    isEnum: '{property} doit être l’une des valeurs suivantes : {values}',
    isIn: '{property} doit être l’une des valeurs suivantes : {values}',
    isUrl: '{property} doit être une URL valide',
    isDateString: '{property} doit être une date ISO 8601 valide',
    isArray: '{property} doit être un tableau',
    arrayMinSize: '{property} doit contenir au moins {min} éléments',
    arrayMaxSize: '{property} doit contenir au plus {max} éléments',
  },
  tiers: {
    ROOKIE: 'Débutant',
    CONTENDER: 'Prétendant',
    CHALLENGER: 'Challenger',
    PRO: 'Pro',
    CHAMPION: 'Champion',
  },
  amenities: {
    Parking: 'Parking',
    Floodlights: 'Éclairage',
    Clubhouse: 'Club-house',
    'Locker rooms': 'Vestiaires',
    'Pro shop': 'Boutique',
    Coaching: 'Coaching',
  },
  notifications: {
    bookingConfirmed: {
      title: 'Court réservé',
      body: '{courtName} à {clubName} · {slot}',
    },
    bookingCancelled: {
      title: 'Réservation annulée',
      body: '{courtName} à {clubName} · {slot} est de nouveau libre.',
    },
    purchaseRequestReceived: {
      title: 'Nouvelle demande d’achat',
      body: '{buyerName} veut votre {productTitle}.',
    },
    purchaseRequestAccepted: {
      title: 'Demande acceptée',
      body: 'Le vendeur a accepté votre demande pour {productTitle}. Son contact est maintenant visible.',
    },
    purchaseRequestDeclined: {
      title: 'Demande refusée',
      body: "Votre demande pour {productTitle} n'a pas été acceptée.",
    },
    tournamentRegistered: {
      title: 'Vous êtes inscrit !',
      body: 'Votre inscription à {name} est confirmée.',
    },
    registrationOpen: {
      title: 'Les inscriptions sont ouvertes',
      body: 'Le Dakar Open Amateur commence dans une semaine — réservez votre place.',
    },
    niceWin: {
      title: 'Belle victoire !',
      body: 'Votre dernier match vous a rapporté des points de saison. Voyez où vous en êtes.',
    },
    courtReminder: {
      title: 'Rappel de court',
      body: 'Une réservation se tient plus facilement avec un partenaire — invitez quelqu’un.',
    },
    newGear: {
      title: 'Du nouveau matériel près de chez vous',
      body: 'De nouvelles raquettes et chaussures viennent d’être mises en vente sur le marché.',
    },
    welcome: {
      title: 'Bienvenue au club',
      body: 'Réservez des courts, enregistrez vos matchs et grimpez au classement de la saison.',
    },
    matchRecorded: {
      title: 'Match ajouté à votre historique',
      body: '{recorderName} a enregistré un match avec vous. {outcome}.',
      win: 'Vous avez gagné',
      loss: 'Vous avez perdu',
      unfinished: 'Inachevé',
    },
  },
};
