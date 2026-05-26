import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ApplicationForm } from "../_components/application-form";

export default function NewApplicationPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-1">
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href="/applications">
            <ArrowLeftIcon />
            Access
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">
          New application
        </h1>
      </div>
      <ApplicationForm />
    </div>
  );
}
