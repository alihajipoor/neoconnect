import { IsString, Length } from "class-validator";

export class OpenTicketDto {
  @IsString()
  @Length(3, 140)
  subject!: string;

  @IsString()
  @Length(1, 5000)
  body!: string;
}
