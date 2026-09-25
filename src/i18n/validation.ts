import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { getMetadataStorage, type ValidationError } from 'class-validator';
import { t, type MessageKey, type MessageParams } from './i18n.js';

// Placeholders each constraint's message needs beyond `{property}`, read from
// the decorator's arguments (`@MinLength(8)` -> min: 8).
const constraintParams = (name: string, args: unknown[]): MessageParams => {
  const [first] = args;
  switch (name) {
    case 'minLength':
    case 'min':
    case 'arrayMinSize':
      return { min: first as number };
    case 'maxLength':
    case 'max':
    case 'arrayMaxSize':
      return { max: first as number };
    case 'isEnum':
      return { values: Object.values(first as object).join(', ') };
    case 'isIn':
      return { values: (first as unknown[]).join(', ') };
    default:
      return {};
  }
};

const decoratorArgs = (error: ValidationError, name: string): unknown[] => {
  const target = error.target?.constructor;
  if (!target) return [];
  return (
    getMetadataStorage()
      .getTargetValidationMetadatas(target, '', true, false)
      .find((m) => m.propertyName === error.property && m.name === name)
      ?.constraints ?? []
  );
};

function messagesFor(errors: ValidationError[], parent = ''): string[] {
  return errors.flatMap((error) => {
    const property = parent ? `${parent}.${error.property}` : error.property;
    const own = Object.keys(error.constraints ?? {}).map((name) => {
      const key = `validation.${name}` as MessageKey;
      const params = {
        property,
        ...constraintParams(name, decoratorArgs(error, name)),
      };
      const message = t(key, params);
      // Unknown constraint: a generic message beats leaking the raw key.
      return message === key ? t('validation.invalid', { property }) : message;
    });
    return [...own, ...messagesFor(error.children ?? [], property)];
  });
}

/** The app-wide ValidationPipe, answering in the request's language. */
export const createValidationPipe = () =>
  new ValidationPipe({
    whitelist: true,
    transform: true,
    // The failing DTO is needed to read each decorator's arguments.
    validationError: { target: true, value: false },
    exceptionFactory: (errors) => new BadRequestException(messagesFor(errors)),
  });
