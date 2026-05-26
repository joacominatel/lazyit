import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ConsumableForm } from "../_components/consumable-form";

export default function NewConsumablePage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-1">
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href="/consumables">
            <ArrowLeftIcon />
            Consumables
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">New consumable</h1>
      </div>
      <ConsumableForm />
    </div>
  );
}
