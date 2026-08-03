import { IsString, Length } from "class-validator";

export class ReplyTicketDto {
  @IsString()
  @Length(1, 5000)
  body!: string;
}
