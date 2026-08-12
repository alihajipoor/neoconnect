import { IsInt, IsNotEmpty, IsString, Max, Min } from "class-validator";

/**
 * A solved proof-of-work challenge, submitted alongside credentials.
 *
 * Every field except `nonce` is echoed back exactly as the server
 * issued it; the HMAC in `signature` is what makes that safe to trust.
 *
 * Attached as an OPTIONAL property to the login and registration DTOs
 * rather than as a required one, because the desktop and Android
 * clients already installed on customers' machines do not send it. The
 * service decides when a missing solution is acceptable -- see
 * CHALLENGE_REQUIRED_AFTER_FAILURES in login-guard.service.ts.
 */
export class ChallengeSolutionDto {
  @IsString()
  @IsNotEmpty()
  id!: string;

  @IsString()
  @IsNotEmpty()
  challenge!: string;

  /**
   * Bounded on both sides. A floor stops a client claiming it solved a
   * trivial challenge; the ceiling stops a malicious one submitting an
   * enormous difficulty that would cost US the verification work --
   * cheap here (one hash) but worth refusing on principle rather than
   * accepting an unbounded integer from the network.
   */
  @IsInt()
  @Min(1)
  @Max(32)
  difficulty!: number;

  @IsInt()
  expiresAt!: number;

  @IsString()
  @IsNotEmpty()
  signature!: string;

  @IsString()
  @IsNotEmpty()
  nonce!: string;
}
