import "./style.css";
import "./survival.css";
import { Game } from "./game.ts";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const ui = document.getElementById("ui") as HTMLElement;
const game = new Game(canvas, ui);
(window as unknown as { __game: Game }).__game = game;
void game.boot();
