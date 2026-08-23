import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/**
 * Validates Egyptian mobile phone numbers.
 * Accepted formats:
 *   - International: +201XXXXXXXXX (13 chars)
 *   - Local:         01XXXXXXXXX  (11 chars)
 * Covers Vodafone (010), Etisalat (011), Orange (012), WE (015).
 */
@ValidatorConstraint({ name: 'isEgyptianPhone', async: false })
export class IsEgyptianPhoneConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    return /^(\+20|0)1[0125]\d{8}$/.test(value);
  }

  defaultMessage(): string {
    return 'phone must be a valid Egyptian mobile number (+201XXXXXXXXX or 01XXXXXXXXX)';
  }
}

export function IsEgyptianPhone(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsEgyptianPhoneConstraint,
    });
  };
}
