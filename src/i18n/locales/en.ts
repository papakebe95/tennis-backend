// Source language. `fr.ts` must have exactly the same shape (checked by the
// compiler), so a missing translation fails the build instead of the app.
type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };

export const en = {
  errors: {
    // Nest's own default messages, so English responses are unchanged.
    http: {
      unauthorized: 'Unauthorized',
      forbidden: 'Forbidden',
      notFound: 'Not Found',
      internal: 'Internal Server Error',
      unexpected: 'Internal server error',
    },
    auth: {
      invalidCredentials: 'Invalid credentials',
      invalidRefreshToken: 'Invalid refresh token',
      emailTaken: 'Email is already registered',
      phoneTaken: 'This phone number is already registered',
      emailOrPhoneTaken: 'This email or phone number is already registered',
    },
    phone: {
      invalid:
        'Enter a valid phone number with its country code, e.g. +221 77 123 45 67',
      notFound: 'Phone number not found',
      max: 'You can add up to {max} extra numbers',
      inUse: 'This number is already in use',
    },
    users: {
      notFound: 'User not found',
      ntrpStep: 'ntrpRating must be a multiple of 0.5',
    },
    clubs: { notFound: 'Club not found' },
    courts: { notFound: 'Court not found' },
    bookings: {
      notFound: 'Booking not found',
      endBeforeStart: 'endTime must be after startTime',
      startInPast: 'startTime must be in the future',
      slotTaken: 'This court is already booked for the requested time range',
      cannotCancel:
        'Cannot cancel a booking that has already started or passed',
    },
    products: {
      notFound: 'Product not found',
      notOwner: 'You do not own this product',
      unknownCategory: 'Unknown product category "{code}"',
    },
    purchaseRequests: {
      notFound: 'Purchase request not found',
      ownProduct: 'You cannot send a purchase request for your own product',
      unavailable: 'This item is no longer available',
      alreadyActive:
        'You already have an active purchase request for this item',
      onlySeller: 'Only the seller can respond to this purchase request',
      notPending: 'This purchase request is no longer pending',
      notYours: 'This is not your purchase request',
      onlyPendingCancel: 'Only pending requests can be cancelled',
    },
    competitions: {
      notFound: 'Tournament not found',
      closed: 'Registration for this tournament is closed',
      full: 'This tournament is full',
      started: 'This tournament has already started',
    },
    matches: {
      notFound: 'Match not found',
      pickOpponent: 'Pick an opponent or type a name',
      selfPlay: "You can't play against yourself",
      opponentNotFound: 'Opponent not found',
      endBeforeStart: 'The match cannot end before it starts',
      playTimeTooLong: 'Play time cannot be longer than the total duration',
      needsWinner: 'A completed match needs a winner',
      needsScore: 'A completed match needs a score',
      onlyRecorderDeletes: 'Only the player who recorded it can delete a match',
    },
    notifications: { notFound: 'Notification not found' },
    uploads: {
      noFile: 'No file provided',
      invalidFolder:
        'Invalid upload folder "{folder}". Allowed folders: {allowed}',
      unsupportedType:
        'Unsupported file type "{type}". Allowed types: {allowed}',
      tooLarge: 'File too large: max size is {max}MB',
    },
  },
  // class-validator messages, keyed by constraint name.
  validation: {
    invalid: '{property} is invalid',
    isEmail: '{property} must be a valid email address',
    isString: '{property} must be a string',
    minLength: '{property} must be at least {min} characters long',
    maxLength: '{property} must be at most {max} characters long',
    min: '{property} must not be less than {min}',
    max: '{property} must not be greater than {max}',
    isInt: '{property} must be an integer',
    isNumber: '{property} must be a number',
    isPositive: '{property} must be a positive number',
    isBoolean: '{property} must be a boolean',
    isEnum: '{property} must be one of: {values}',
    isIn: '{property} must be one of: {values}',
    isUrl: '{property} must be a valid URL',
    isDateString: '{property} must be a valid ISO 8601 date',
    isArray: '{property} must be an array',
    arrayMinSize: '{property} must contain at least {min} items',
    arrayMaxSize: '{property} must contain at most {max} items',
  },
  tiers: {
    ROOKIE: 'Rookie',
    CONTENDER: 'Contender',
    CHALLENGER: 'Challenger',
    PRO: 'Pro',
    CHAMPION: 'Champion',
  },
  // Club amenities are stored as their English label; the label is the key.
  amenities: {
    Parking: 'Parking',
    Floodlights: 'Floodlights',
    Clubhouse: 'Clubhouse',
    'Locker rooms': 'Locker rooms',
    'Pro shop': 'Pro shop',
    Coaching: 'Coaching',
  },
  notifications: {
    bookingConfirmed: {
      title: 'Court booked',
      body: '{courtName} at {clubName} · {slot}',
    },
    bookingCancelled: {
      title: 'Booking cancelled',
      body: '{courtName} at {clubName} · {slot} is free again.',
    },
    purchaseRequestReceived: {
      title: 'New purchase request',
      body: '{buyerName} wants your {productTitle}.',
    },
    purchaseRequestAccepted: {
      title: 'Request accepted',
      body: 'The seller accepted your request for {productTitle}. Their contact is now visible.',
    },
    purchaseRequestDeclined: {
      title: 'Request declined',
      body: "Your request for {productTitle} wasn't accepted.",
    },
    tournamentRegistered: {
      title: "You're in!",
      body: 'Your registration for {name} is confirmed.',
    },
    registrationOpen: {
      title: 'Registration is open',
      body: 'Dakar Open Amateur starts in a week — grab your spot.',
    },
    niceWin: {
      title: 'Nice win!',
      body: 'Your last match earned you season points. See where you stand.',
    },
    courtReminder: {
      title: 'Court reminder',
      body: 'Bookings are easier to keep with a partner — invite someone.',
    },
    newGear: {
      title: 'New gear near you',
      body: 'Fresh rackets and shoes were just listed in the market.',
    },
    welcome: {
      title: 'Welcome to the club',
      body: 'Book courts, score your matches and climb the season ranking.',
    },
    matchRecorded: {
      title: 'Match added to your history',
      body: '{recorderName} recorded a match with you. {outcome}.',
      win: 'You won',
      loss: 'You lost',
      unfinished: 'Unfinished',
    },
  },
} as const;

export type Messages = Widen<typeof en>;
