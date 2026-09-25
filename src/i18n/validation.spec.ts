import { ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsEmail,
  IsEnum,
  IsInt,
  IsString,
  Max,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { describe, expect, it } from 'vitest';
import { runWithLang } from './i18n.js';
import { createValidationPipe } from './validation.js';

enum Side {
  LEFT = 'LEFT',
  RIGHT = 'RIGHT',
}

class Child {
  @IsInt()
  @Max(7)
  games!: number;
}

class Dto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsEnum(Side)
  side!: Side;

  @ArrayMaxSize(1)
  tags!: string[];

  @ValidateNested()
  @Type(() => Child)
  child!: Child;
}

const meta: ArgumentMetadata = { type: 'body', metatype: Dto };
const bad = {
  email: 'nope',
  password: 'short',
  side: 'UP',
  tags: ['a', 'b'],
  child: { games: 9 },
};

const messages = async (lang: 'en' | 'fr') => {
  try {
    await runWithLang(lang, () => createValidationPipe().transform(bad, meta));
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).getResponse() as {
      message: string[];
      error: string;
      statusCode: number;
    };
  }
  throw new Error('expected a validation error');
};

describe('validation messages', () => {
  it('keeps the usual 400 shape and words each rule in French', async () => {
    const body = await messages('fr');
    expect(body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
    expect(body.message).toEqual(
      expect.arrayContaining([
        'email doit être une adresse e-mail valide',
        'password doit contenir au moins 8 caractères',
        'side doit être l’une des valeurs suivantes : LEFT, RIGHT',
        'tags doit contenir au plus 1 éléments',
        'child.games ne doit pas être supérieur à 7',
      ]),
    );
  });

  it('answers in English by default', async () => {
    const { message } = await messages('en');
    expect(message).toContain('password must be at least 8 characters long');
    expect(message).toContain('child.games must not be greater than 7');
  });
});
